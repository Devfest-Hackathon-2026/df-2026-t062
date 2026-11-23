// PostgreSQL で、再配信・部分失敗・反映中の障害を検証する。別スキーマを使う。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createPool, tx, type Db } from '../db/pool.ts'
import { migrate } from '../db/migrate.ts'
import { seed } from '../db/seed.ts'
import { applyBatch, completeRecording, createClient, createRecording, activeJobs, type Staff } from '../db/repo.ts'
import {
  beginSourceDeletion,
  claimExpiredSourceRecordings,
  getRecordingRetention,
  markExpiredSourceRecordingsEligible,
  RECORDING_MAX_RETENTION_DAYS,
  releaseExpiredRecordingRetentionHolds,
  releaseRecordingRetentionHold,
  setRecordingRetentionHold,
} from '../db/recording-retention.ts'
import { FakeSpeakers, FakeStt, FakeSummarizer, fakeFormImport } from '../worker/fake.ts'
import { reconcile, runJob, type WorkerDeps } from '../worker/jobs.ts'
import { ZERO_USAGE, type Providers } from '../worker/types.ts'
import { LocalStorage } from '../api/storage.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_worker_retry_${process.pid}`
let db: Db
let staff: Staff
let storage: LocalStorage

before(async () => {
  if (!url) return
  const admin = await createPool({ DATABASE_URL: url })
  await admin.query(`CREATE SCHEMA ${schema}`)
  await admin.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema })
  await migrate(db)
  staff = (await seed(db)).staff
  storage = new LocalStorage(`/tmp/t062-worker-retry-${process.pid}`)
})

after(async () => {
  if (!url) return
  await db.query(`DROP SCHEMA ${schema} CASCADE`)
  await db.end()
})

async function job() {
  const client = await createClient(db, staff, { name: `障害注入 ${randomUUID()}` })
  const rec = await tx(db, (c) => createRecording(c, staff, client.id, 'audio/webm', randomUUID()))
  const bytes = Buffer.alloc(4096)
  await storage.write('source', rec.objectPath, bytes)
  const jobId = await completeRecording(db, staff, rec.id, 60_000, bytes.byteLength, (path) => storage.size('source', path))
  assert.ok(jobId)
  return { jobId, recordingId: rec.id, clientId: client.id, documentId: client.documentId }
}

const providers = (write: Providers['recording']['writer']['write']): Providers => ({
  stt: new FakeStt(), speakers: new FakeSpeakers(), formImport: fakeFormImport, recording: { summarizer: new FakeSummarizer(), writer: { write } },
})
const deps = (p: Providers): WorkerDeps => ({ db: async () => db, storage: () => storage, providers: async () => p })
const value = { 'intake.method': { value: '電話', cite: [] } }
const result = { values: value, usage: ZERO_USAGE, failed: [] as string[], incompleteFields: [] as string[] }
const status = async (id: string) => (await db.query('SELECT status, attempts, run_token FROM jobs WHERE id = $1', [id])).rows[0]
const batches = async (id: string) => Number((await db.query('SELECT count(*) AS n FROM batches WHERE job_id = $1', [id])).rows[0].n)
test('一時失敗後に再配信で再開し、同じジョブの二重配信は一度しか反映しない', { skip }, async () => {
  const j = await job()
  const before = await getRecordingRetention(db, j.recordingId, staff.officeId)
  assert.ok(before)
  let calls = 0
  const p = providers(async () => {
    calls++
    if (calls === 1) throw new Error('injected transient error')
    return result
  })
  await assert.rejects(runJob(deps(p), j.jobId), /injected transient error/)
  assert.equal((await status(j.jobId)).status, 'queued')
  assert.deepEqual((await getRecordingRetention(db, j.recordingId, staff.officeId))?.sourceExpiresAt, before.sourceExpiresAt)
  await Promise.all([runJob(deps(p), j.jobId), runJob(deps(p), j.jobId)])
  assert.equal((await status(j.jobId)).status, 'succeeded')
  const after = await getRecordingRetention(db, j.recordingId, staff.officeId)
  assert.ok(after)
  assert.equal(after.sourceExpiresAt, before.sourceExpiresAt)
  assert.equal((await status(j.jobId)).attempts, 2)
  assert.equal(await batches(j.jobId), 1)
  await runJob(deps(p), j.jobId)
  assert.equal(await batches(j.jobId), 1)
})

test('部分失敗を API のジョブ情報で伝え、再配信でも二重反映しない', { skip }, async () => {
  const j = await job()
  const before = await getRecordingRetention(db, j.recordingId, staff.officeId)
  assert.ok(before)
  await runJob(deps(providers(async () => ({ ...result, failed: ['check:3'], incompleteFields: ['assessment.lifeHistory'] }))), j.jobId)
  assert.equal((await status(j.jobId)).status, 'partial')
  const retention = await getRecordingRetention(db, j.recordingId, staff.officeId)
  assert.ok(retention)
  assert.equal(retention.sourceDeleteStatus, 'pending')
  assert.equal(retention.sourceExpiresAt, before.sourceExpiresAt)
  const view = (await activeJobs(db, staff.officeId, j.clientId))[0]
  assert.deepEqual(view.incompleteFields, ['assessment.lifeHistory'])
  assert.equal(view.batch?.changes, 2) // AI の欄と初回面談日
  await db.query("UPDATE jobs SET updated_at = now() - interval '1 day' WHERE id = $1", [j.jobId])
  assert.equal((await activeJobs(db, staff.officeId, j.clientId))[0].status, 'partial')
  await runJob(deps(providers(async () => { throw new Error('should not run') })), j.jobId)
  assert.equal(await batches(j.jobId), 1)
})

test('期限付き保全は削除開始前まで候補を取り消し、削除開始後は設定できない', { skip }, async () => {
  const j = await job()
  await db.query("UPDATE recordings SET recorded_at = now() - interval '8 days', source_expires_at = now() - interval '1 day', source_delete_status = 'pending' WHERE id = $1", [j.recordingId])
  const holdUntil = new Date(Date.now() + 60_000)
  await setRecordingRetentionHold(db, j.recordingId, { officeId: staff.officeId, actorStaffId: staff.id }, holdUntil, 'legal_request')
  assert.equal((await getRecordingRetention(db, j.recordingId, staff.officeId))?.retentionHold, true)
  await markExpiredSourceRecordingsEligible(db)
  assert.equal((await getRecordingRetention(db, j.recordingId, staff.officeId))?.sourceDeleteStatus, 'pending')
  await releaseRecordingRetentionHold(db, j.recordingId, { officeId: staff.officeId, actorStaffId: staff.id })
  assert.equal((await getRecordingRetention(db, j.recordingId, staff.officeId))?.sourceDeleteStatus, 'eligible')
  const candidates = await claimExpiredSourceRecordings(db)
  assert.ok(candidates.some((candidate) => candidate.recordingId === j.recordingId))
  assert.equal((await getRecordingRetention(db, j.recordingId, staff.officeId))?.sourceDeleteStatus, 'requested')

  const renewedUntil = new Date(Date.now() + 120_000)
  await setRecordingRetentionHold(db, j.recordingId, { officeId: staff.officeId, actorStaffId: staff.id }, renewedUntil, 'renewed_legal_request')
  assert.equal((await getRecordingRetention(db, j.recordingId, staff.officeId))?.sourceDeleteStatus, 'pending')
  assert.equal(await beginSourceDeletion(db, j.recordingId, staff.officeId), null)
  await releaseRecordingRetentionHold(db, j.recordingId, { officeId: staff.officeId, actorStaffId: staff.id })
  assert.ok((await claimExpiredSourceRecordings(db)).some((candidate) => candidate.recordingId === j.recordingId))
  assert.equal((await beginSourceDeletion(db, j.recordingId, staff.officeId))?.sourceDeleteStatus, 'deleting')
  await assert.rejects(
    setRecordingRetentionHold(db, j.recordingId, { officeId: staff.officeId, actorStaffId: staff.id }, new Date(Date.now() + 180_000), 'too_late'),
    /recording_deletion_in_progress/,
  )

  const events = (await db.query(
    "SELECT action, detail FROM audit_events WHERE detail->>'recordingId' = $1 ORDER BY occurred_at",
    [j.recordingId],
  )).rows
  const actions = events.map((row) => row.action)
  assert.ok(actions.includes('recording.retention_set'))
  assert.ok(actions.includes('recording.retention_hold_set'))
  assert.ok(actions.includes('recording.retention_hold_released'))
  assert.ok(actions.includes('recording.delete_requested'))
  const firstHold = events.find((event) => event.action === 'recording.retention_hold_set')
  const firstRelease = events.find((event) => event.action === 'recording.retention_hold_released')
  assert.ok(firstHold)
  assert.ok(firstRelease)
  assert.equal(firstHold.detail.holdUntil, holdUntil.toISOString())
  assert.equal(firstHold.detail.reasonCode, 'legal_request')
  assert.equal(firstRelease.detail.holdUntil, holdUntil.toISOString())
  assert.equal(firstRelease.detail.reasonCode, 'legal_request')
})

test('期限切れ保全は自動解除され、解除理由を監査ログに残す', { skip }, async () => {
  const j = await job()
  await db.query("UPDATE recordings SET source_expires_at = now() - interval '1 day' WHERE id = $1", [j.recordingId])
  await setRecordingRetentionHold(
    db,
    j.recordingId,
    { officeId: staff.officeId, actorStaffId: staff.id },
    new Date(Date.now() + 60_000),
    'temporary_investigation',
  )
  await db.query(
    `UPDATE recordings
        SET retention_hold_set_at = now() - interval '2 days',
            retention_hold_until = now() - interval '1 day'
      WHERE id = $1`,
    [j.recordingId],
  )
  assert.ok((await releaseExpiredRecordingRetentionHolds(db)) >= 1)
  const retention = await getRecordingRetention(db, j.recordingId, staff.officeId)
  assert.equal(retention?.retentionHold, false)
  assert.equal(retention?.sourceDeleteStatus, 'eligible')
  const audit = (await db.query(
    "SELECT detail FROM audit_events WHERE action = 'recording.retention_hold_released' AND detail->>'recordingId' = $1 ORDER BY occurred_at DESC LIMIT 1",
    [j.recordingId],
  )).rows[0]
  assert.equal(audit.detail.trigger, 'expired')
  assert.equal(audit.detail.reasonCode, 'temporary_investigation')
})

test('反映の transaction が失敗すれば書き込みは残らず、再実行で一度だけ確定する', { skip }, async () => {
  const j = await job()
  const token = randomUUID()
  await db.query("UPDATE jobs SET status = 'processing', attempts = 1, run_token = $2, lease_until = now() + interval '30 minutes' WHERE id = $1", [j.jobId, token])
  const input = {
    officeId: staff.officeId, documentId: j.documentId, kind: 'recording' as const, jobId: j.jobId,
    label: '障害注入', proposed: value,
    completion: { token, status: 'succeeded' as const, steps: {} },
  }
  await assert.rejects(applyBatch(db, input, (fn) => tx(db, async (c) => { await fn(c); throw new Error('injected before commit') })), /injected before commit/)
  assert.equal(await batches(j.jobId), 0)
  assert.equal((await status(j.jobId)).status, 'processing')
  await applyBatch(db, input)
  assert.equal(await batches(j.jobId), 1)
  assert.equal((await status(j.jobId)).status, 'succeeded')
})

test('試行上限に達したジョブは failed になり、次の配信で再実行しない', { skip }, async () => {
  const j = await job()
  const before = await getRecordingRetention(db, j.recordingId, staff.officeId)
  assert.ok(before)
  const broken = deps(providers(async () => { throw new Error('injected permanent error') }))
  for (let i = 0; i < 3; i++) await assert.rejects(runJob(broken, j.jobId), /injected permanent error/)
  assert.equal((await status(j.jobId)).status, 'failed')
  assert.equal((await status(j.jobId)).attempts, 3)
  await runJob(broken, j.jobId)
  assert.equal((await status(j.jobId)).attempts, 3)
  assert.equal(await batches(j.jobId), 0)
  assert.equal((await getRecordingRetention(db, j.recordingId, staff.officeId))?.sourceExpiresAt, before.sourceExpiresAt)
})

test('古い実行トークンでは反映できず、引き継いだ実行だけが確定できる', { skip }, async () => {
  const j = await job()
  const oldToken = randomUUID()
  const newToken = randomUUID()
  await db.query("UPDATE jobs SET status = 'processing', attempts = 2, run_token = $2, lease_until = now() + interval '30 minutes' WHERE id = $1", [j.jobId, newToken])
  const input = {
    officeId: staff.officeId, documentId: j.documentId, kind: 'recording' as const, jobId: j.jobId,
    label: '引き継ぎ', proposed: value,
    completion: { token: oldToken, status: 'succeeded' as const, steps: {} },
  }
  await assert.rejects(applyBatch(db, input), /job_lease/)
  assert.equal(await batches(j.jobId), 0)
  await applyBatch(db, { ...input, completion: { ...input.completion, token: newToken } })
  assert.equal(await batches(j.jobId), 1)
})

test('変更が0件でも完了し、試行上限に達したリース切れジョブは見回りで終了する', { skip }, async () => {
  const empty = await job()
  await db.query("UPDATE recordings SET recorded_at = now() - interval '6 days', source_expires_at = now() + interval '1 day' WHERE id = $1", [empty.recordingId])
  const token = randomUUID()
  await db.query("UPDATE jobs SET status = 'processing', attempts = 1, run_token = $2, lease_until = now() + interval '30 minutes' WHERE id = $1", [empty.jobId, token])
  const r = await applyBatch(db, {
    officeId: staff.officeId, documentId: empty.documentId, kind: 'recording', jobId: empty.jobId,
    label: '変更なし', proposed: {}, completion: { token, status: 'succeeded', steps: {} },
  })
  assert.equal(r.batchId, null)
  assert.equal((await status(empty.jobId)).status, 'succeeded')
  const cap = (await db.query(
    'SELECT extract(epoch FROM source_expires_at - recorded_at) AS seconds FROM recordings WHERE id = $1',
    [empty.recordingId],
  )).rows[0]
  assert.equal(Number(cap.seconds), RECORDING_MAX_RETENTION_DAYS * 24 * 60 * 60)

  const expired = await job()
  await db.query("UPDATE jobs SET status = 'processing', attempts = 3, run_token = $2, lease_until = now() - interval '1 minute' WHERE id = $1", [expired.jobId, randomUUID()])
  const sent: string[] = []
  await reconcile(deps(providers(async () => result)), async (id) => { sent.push(id) })
  assert.equal((await status(expired.jobId)).status, 'failed')
  assert.ok(!sent.includes(expired.jobId))
})
