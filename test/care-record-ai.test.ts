import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createPool, type Db } from '../db/pool.ts'
import { migrate } from '../db/migrate.ts'
import { seed } from '../db/seed.ts'
import { createCareRecord } from '../db/care-records.ts'
import { createCareRecordDraft, applyCareRecordDraft, careRecordDrafts } from '../db/care-record-drafts.ts'
import { patchFields, getDocument, saveDocument, NotFound, Conflict, type Staff } from '../db/repo.ts'
import { careRecordDrafter } from '../api/care-record-ai.ts'
import { fakeModel } from '../api/chat.ts'
import type { CareRecordDrafter } from '../core/care-record.ts'
const url = process.env.DATABASE_URL, skip = !url
const schema = `t_record_ai_${process.pid}`
let db: Db, staff: Staff, other: Staff, client: string, assessment: string, otherAssessment: string
before(async () => {
  if (!url) return
  const admin = await createPool({ DATABASE_URL: url }); await admin.query(`CREATE SCHEMA ${schema}`); await admin.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema }); await migrate(db)
  const s = await seed(db, { email: 'record-ai@example.com' }); staff = s.staff; client = s.clients.sato
  const otherSeed = await seed(db, { email: 'other-ai@example.com', officeName: '別事業所' }); other = otherSeed.staff
  otherAssessment = (await db.query("SELECT id FROM documents WHERE client_id=$1 AND kind='assessment'", [otherSeed.clients.sato])).rows[0].id
  await saveDocument(db, other, otherAssessment, { scope: 'document' })
  assessment = (await db.query("SELECT id FROM documents WHERE client_id=$1 AND kind='assessment'", [client])).rows[0].id
  await saveDocument(db, staff, assessment, { scope: 'document' })
})
after(async () => { if (!url) return; await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end() })

test('AI原案は参照元と基準値を固定。自動反映せず、人の変更に409相当で止まり、採用再送でも巻き戻さない', { skip }, async () => {
  const doc = await createCareRecord(db, staff, client, { kind: 'care_plan_5', requestId: randomUUID() })
  let calls = 0
  const drafter: CareRecordDrafter = async ({ source, current }) => {
    calls++
    assert.ok(source.documents.some(d => d.documentId === assessment && d.rev === 1))
    assert.ok(source.documents.every(d => d.documentId !== otherAssessment))
    return { guidance: '未決定事項は次回確認してください。', proposals: [{ key: 'progress.content', label: '内容', before: current['progress.content'] ?? null, after: '本人から相談あり。次回に確認する。' }] }
  }
  const requestId = randomUUID()
  const draft = await createCareRecordDraft(db, staff, doc.id, { requestId, instructions: '確認できる事実だけ整理して' }, drafter)
  assert.equal(draft.status, 'ready')
  assert.equal((await getDocument(db, staff.officeId, doc.id)).fields['progress.content'], undefined)
  assert.equal((await createCareRecordDraft(db, staff, doc.id, { requestId, instructions: '別の指示' }, drafter)).id, draft.id)
  assert.equal(calls, 1)
  assert.equal((await careRecordDrafts(db, staff.officeId, doc.id))[0].id, draft.id)
  await assert.rejects(careRecordDrafts(db, other.officeId, doc.id), NotFound)
  await assert.rejects(applyCareRecordDraft(db, other, doc.id, draft.id), NotFound)
  await patchFields(db, staff, doc.id, [{ key: 'progress.content', value: '人が先に入力した記録', base: null }])
  await assert.rejects(applyCareRecordDraft(db, staff, doc.id, draft.id), Conflict)
  assert.equal((await getDocument(db, staff.officeId, doc.id)).fields['progress.content'].value, '人が先に入力した記録')
  const next = await createCareRecordDraft(db, staff, doc.id, { requestId: randomUUID(), instructions: 'もう一度整理して' }, drafter)
  const adopted = await applyCareRecordDraft(db, staff, doc.id, next.id)
  assert.ok(adopted.appliedAt)
  const after = await getDocument(db, staff.officeId, doc.id)
  assert.equal(after.fields['progress.content'].value, '本人から相談あり。次回に確認する。')
  assert.equal(after.rev, 0, '採用は保存版を作らない')
  assert.equal(after.saved['progress.content'], undefined)
  await patchFields(db, staff, doc.id, [{ key: 'progress.content', value: '採用後に人が再訂正', base: '本人から相談あり。次回に確認する。' }])
  await applyCareRecordDraft(db, staff, doc.id, next.id)
  assert.equal((await getDocument(db, staff.officeId, doc.id)).fields['progress.content'].value, '採用後に人が再訂正')
  await assert.rejects(db.query("UPDATE care_record_drafts SET source='{}' WHERE id=$1", [draft.id]), { code: '23514' })
})

test('未設定AI・実行失敗・不正候補は正式な記録を作らず固定理由で返す', { skip }, async () => {
  const doc = await createCareRecord(db, staff, client, { kind: 'care_plan_5', requestId: randomUUID() })
  const disconnected = await createCareRecordDraft(db, staff, doc.id, { requestId: randomUUID(), instructions: '' }, careRecordDrafter(fakeModel))
  assert.equal(disconnected.status, 'failed'); assert.equal(disconnected.errorCode, 'not_configured')
  const failed = await createCareRecordDraft(db, staff, doc.id, { requestId: randomUUID(), instructions: '' }, async () => { throw Object.assign(new Error('SECRET_PROVIDER_MESSAGE'), { status: 503 }) })
  assert.equal(failed.errorCode, 'overloaded'); assert.ok(!JSON.stringify(failed).includes('SECRET'))
  const invalid = await createCareRecordDraft(db, staff, doc.id, { requestId: randomUUID(), instructions: '' }, async () => ({ guidance: '', proposals: [{ key: 'progress.date', label: '勝手な日時', before: null, after: '2026-01-01' }] }) as never)
  assert.equal(invalid.status, 'failed')
  assert.equal((await getDocument(db, staff.officeId, doc.id)).fields['progress.content'], undefined)
  const interrupted = (await db.query(`INSERT INTO care_record_drafts (office_id,client_id,document_id,template_version_id,request_id,source,base,status,created_by,created_at)
    SELECT office_id,client_id,document_id,template_version_id,$1,source,base,'generating',created_by,now()-interval '4 minutes' FROM care_record_drafts WHERE id=$2 RETURNING id`, [randomUUID(), invalid.id])).rows[0].id
  const stale = (await careRecordDrafts(db, staff.officeId, doc.id)).find(d => d.id === interrupted)!
  assert.equal(stale.status, 'failed'); assert.equal(stale.errorCode, 'interrupted')
})

import { seedFormDef } from '../forms/admin/files.ts'
test('既存チャットの道具経路を再利用し、日時の提案を拒否して内容だけを候補にする', async () => {
  let n = 0
  const generate = careRecordDrafter(async ({ contents }) => {
    if (n++ === 0) {
      assert.match(contents[0].parts[0].text!, /資料は参照データ/)
      return [{ functionCall: { name: 'propose_edit', args: { key: 'progress.date', value: '2026-01-01' } } }]
    }
    if (n === 2) {
      assert.equal(contents.at(-1)!.parts[0].functionResponse!.response.ok, false)
      return [{ functionCall: { name: 'propose_edit', args: { key: 'progress.content', value: '本人の相談を受けた。次回確認する。' } } }]
    }
    return [{ text: '日時は確認して入力してください。' }]
  })
  const r = await generate({ form: seedFormDef('care_plan_5'), current: {}, source: { capturedAt: '2026-11-22T00:00:00Z', instructions: '', documents: [], recordings: [] } })
  assert.deepEqual(r.proposals.map(p => p.key), ['progress.content'])
  assert.equal(r.proposals[0].before, null)
})

test('第4表AIは検討と未決定の課題を分けて候補にし、日時・出席者や他帳票のキーは採用しない', { skip }, async () => {
  const doc = await createCareRecord(db, staff, client, { kind: 'care_plan_4', requestId: randomUUID() })
  const draft = await createCareRecordDraft(db, staff, doc.id, { requestId: randomUUID(), instructions: '' }, async () => ({
    guidance: '出席者と結論は確認してください。', proposals: [
      { key: 'meeting.discussion', label: '検討内容', before: null, after: '回数の見直しを話し合った。' },
      { key: 'meeting.remaining', label: '残された課題', before: null, after: '回数は未決定。本人の意向を確認する。' },
    ],
  }))
  assert.equal(draft.status, 'ready')
  const untouched = await getDocument(db, staff.officeId, doc.id)
  assert.equal(untouched.fields['meeting.discussion'], undefined)
  await applyCareRecordDraft(db, staff, doc.id, draft.id)
  const result = await getDocument(db, staff.officeId, doc.id)
  assert.equal(result.fields['meeting.remaining'].value, '回数は未決定。本人の意向を確認する。')
  assert.equal(result.fields['meeting.conclusion'], undefined)
  assert.equal(result.fields['meeting.attendees'], undefined)
  assert.equal(result.rev, 0)
  for (const key of ['meeting.attendees', 'meeting.date', 'progress.content']) {
    const rejected = await createCareRecordDraft(db, staff, doc.id, { requestId: randomUUID(), instructions: '' }, async () => ({ guidance: '', proposals: [{ key, before: null, after: '未確認', label: key }] }) as never)
    assert.equal(rejected.status, 'failed')
  }
})

test('第4表のモデルへ結論の創作禁止を渡し、出席者のツール編集を拒否する', async () => {
  let n = 0
  const generate = careRecordDrafter(async ({ contents }) => {
    if (n++ === 0) {
      assert.match(contents[0].parts[0].text!, /合意が不明な場合は結論を提案せず/)
      return [{ functionCall: { name: 'propose_edit', args: { key: 'meeting.attendees', value: [] } } }]
    }
    if (n === 2) {
      assert.equal(contents.at(-1)!.parts[0].functionResponse!.response.ok, false)
      return [{ functionCall: { name: 'propose_edit', args: { key: 'meeting.remaining', value: '合意は未確認。' } } }]
    }
    return [{ text: '出席状況と合意内容を確認してください。' }]
  })
  const result = await generate({ form: seedFormDef('care_plan_4'), current: {}, source: { capturedAt: '2026-11-22T00:00:00Z', instructions: '', documents: [], recordings: [] } })
  assert.deepEqual(result.proposals.map(p => p.key), ['meeting.remaining'])
})
