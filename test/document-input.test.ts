import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createCanvas } from '@napi-rs/canvas'
import { createApp } from '../api/app.ts'
import { DevVerifier } from '../api/auth.ts'
import { LocalStorage } from '../api/storage.ts'
import { documentInputPath } from '../core/document-input.ts'
import { createPool, type Db } from '../db/pool.ts'
import { migrate } from '../db/migrate.ts'
import { seed } from '../db/seed.ts'
import * as repo from '../db/repo.ts'
import { runDocumentInput, reconcileDocumentInputs } from '../worker/document-input/job.ts'
import { ZERO_USAGE, type Providers } from '../worker/types.ts'
import { FakeStt, FakeSpeakers, fakeFormImport } from '../worker/fake.ts'

const skip = !process.env.DATABASE_URL && 'DATABASE_URL がないため省略'
const schema = `t_document_inputs_${process.pid}`
let db: Db
let storage: LocalStorage
let root: string
let staff: repo.Staff
let doc: string
let sibling: string
let app: ReturnType<typeof createApp>
let readCalls = 0
let writeCalls = 0
let failWrite = false
let enqueueFails = false
const queued: string[] = []
const data = createCanvas(40, 40).toBuffer('image/png')
const providers: Providers = {
  stt: new FakeStt(), speakers: new FakeSpeakers(), writer: {
    async write(input) {
      writeCalls++
      if (failWrite) { failWrite = false; throw new Error('Synthetic writer failure') }
      assert.equal(input.visits.length, 1)
      assert.equal(input.visits[0].scenes[0].kind, '書類')
      assert.ok(input.allowedKeys?.includes('survey.2_2'))
      const entries = input.visits[0].scenes[0].entries
      assert.equal(entries.length, 1, '判読不確実な原文は書込処理に渡さない')
      const cite = [entries[0].id]
      return { values: {
        'survey.2_2': { value: '一部介助', cite }, 'survey.2_4': { value: '見守り等', cite },
        'survey.2_5': { value: '一部介助', cite: ['unknown-id'] },
        'unknown.key': { value: '候補外', cite },
      }, usage: ZERO_USAGE, failed: [], incompleteFields: [] }
    },
  }, formImport: fakeFormImport,
  documentRead: () => ({ ask: async () => { readCalls++; return {
    entries: [
      { text: '移動は一部介助、食事は見守り。', recordedOn: '2026-11-01', region: null, uncertain: false },
      { text: '排尿は印が薄く判読不能。', recordedOn: null, region: null, uncertain: true },
    ], issues: ['排尿の印を確認してください'],
  } }, usage: () => ZERO_USAGE }),
}
const deps = { db: async () => db, storage: () => storage, providers: async () => providers }
const call = async (path: string, method = 'GET', body?: unknown, email = 'kato@example.com') => {
  const response = await app.request(path, { method, headers: { Authorization: `Bearer dev:${email}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, response, body: response.headers.get('content-type')?.includes('json') ? await response.json() : null }
}
async function start(documentId = doc, bytes: Uint8Array = data) {
  const r = await call(`/api/documents/${documentId}/inputs`, 'POST', {
    fileName: '架空の記入済み書類.png', mime: 'image/png', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
  assert.equal(r.status, 201)
  return r.body as { input: { id: string }, uploadUrl: string | null }
}
async function uploaded(documentId = doc, bytes: Uint8Array = data) {
  const r = await start(documentId, bytes)
  const row = (await db.query('SELECT client_id FROM document_inputs WHERE id=$1', [r.input.id])).rows[0]
  await storage.writeOnce('source', documentInputPath(staff.officeId, row.client_id, r.input.id), bytes)
  return r.input.id
}
before(async () => {
  if (skip) return
  const admin = await createPool({ DATABASE_URL: process.env.DATABASE_URL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  await admin.end()
  db = await createPool({ DATABASE_URL: process.env.DATABASE_URL, DB_SCHEMA: schema })
  await migrate(db)
  staff = (await seed(db)).staff
  await seed(db, { email: 'other@example.com' })
  const made = await repo.createClient(db, staff, { name: '架空 検証' })
  doc = made.documentId
  sibling = (await repo.createDocument(db, staff, made.id, 'admission')).id
  root = await mkdtemp(join(tmpdir(), 'document-input-test-'))
  storage = new LocalStorage(root)
  app = createApp({ db: async () => db, verifier: () => new DevVerifier(), storage: () => storage, queue: () => ({
    enqueue: async () => {}, enqueueFormImport: async () => {}, enqueueDocumentInput: async (id) => {
      if (enqueueFails) { enqueueFails = false; throw new Error('Synthetic queue failure') }
      queued.push(id)
    },
  }) })
})
after(async () => {
  if (!db) return
  await db.query(`DROP SCHEMA ${schema} CASCADE`)
  await db.end()
  await rm(root, { recursive: true, force: true })
})

test('care.work と事業所で認可し、白紙様式の置き場と分ける。重複アップロードは1件になる', { skip }, async () => {
  const a = await start()
  const b = await start()
  assert.equal(a.input.id, b.input.id)
  assert.equal(a.uploadUrl, b.uploadUrl)
  assert.equal((await call(`/api/documents/${doc}/inputs`, 'GET', undefined, 'other@example.com')).status, 404)
  for (const path of [`/api/document-inputs/${a.input.id}`, `/api/document-inputs/${a.input.id}/original`]) {
    assert.equal((await call(path, 'GET', undefined, 'other@example.com')).status, 404)
  }
  assert.equal((await app.request(`/api/document-inputs/${a.input.id}`)).status, 401)
  assert.equal((await call(`/api/document-inputs/${a.input.id}/complete`, 'POST', {})).status, 409)
  assert.equal((await db.query('SELECT count(*) FROM form_imports')).rows[0].count, '0')
})
test('アップロード完了と読取の重複は安全。候補ができても用紙を書き換えない', { skip }, async () => {
  const id = await uploaded()
  const before = await repo.getDocument(db, staff.officeId, doc)
  await Promise.all([call(`/api/document-inputs/${id}/complete`, 'POST', {}), call(`/api/document-inputs/${id}/complete`, 'POST', {})])
  const n = readCalls
  const writes = writeCalls
  await Promise.all([runDocumentInput(deps, id), runDocumentInput(deps, id)])
  assert.equal(readCalls, n + 1)
  assert.equal(writeCalls, writes + 1)
  assert.ok(queued.includes(id))
  const r = (await call(`/api/document-inputs/${id}`)).body.input
  assert.equal(r.status, 'review')
  assert.deepEqual(r.result.candidates.map((c: { key: string }) => c.key), ['survey.2_2', 'survey.2_4'])
  assert.equal(r.result.evidence.length, 2)
  assert.ok(r.result.incompleteFields.includes('survey.2_5'))
  assert.deepEqual((await repo.getDocument(db, staff.officeId, doc)).fields, before.fields)
  const original = await call(`/api/document-inputs/${id}/original`)
  assert.equal(original.status, 200)
  assert.equal(original.response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await original.response.arrayBuffer()), data)
})
test('本人確認と候補・型を確かめ、編集・採用を原子的に行う。別書類には反映しない', { skip }, async () => {
  const id = (await start()).input.id
  const path = `/api/document-inputs/${id}/adopt`
  const changes = [{ key: 'survey.2_2', value: '見守り等', base: null }]
  assert.equal((await call(path, 'POST', { changes })).status, 400)
  assert.equal((await call(path, 'POST', { identityConfirmed: true, changes }, 'other@example.com')).status, 404)
  assert.equal((await call(path, 'POST', { identityConfirmed: true, changes: [{ ...changes[0], value: 123 }] })).status, 400)
  assert.equal((await call(path, 'POST', { identityConfirmed: true, changes: [{ key: 'unknown.key', value: '不正', base: null }] })).status, 400)
  const r = await call(path, 'POST', { identityConfirmed: true, changes })
  assert.equal(r.status, 200)
  const field = r.body.document.fields['survey.2_2']
  assert.equal(field.value, '見守り等')
  assert.equal(field.by, 'cm')
  assert.equal(field.documentSource.inputId, id)
  const reread = (await call(`/api/document-inputs/${id}`)).body.input
  assert.equal(reread.adoptedValues['survey.2_2'], '見守り等', '修正した採用値は画面を開き直しても残る')
  assert.equal(reread.result.candidates[0].value, '一部介助', '評価用の生成候補は改変しない')
  assert.equal(field.documentSource.evidence[0].recordedOn, '2026-11-01')
  assert.equal((await repo.getDocument(db, staff.officeId, sibling)).fields['survey.2_2'], undefined)
  assert.equal((await call(path, 'POST', { identityConfirmed: true, changes })).status, 200, '採用の再送は冪等')
})
test('読取後の人の編集と競合したら、全候補と採用状態をロールバックする', { skip }, async () => {
  const client = await repo.createClient(db, staff, { name: '架空 競合' })
  const id = await uploaded(client.documentId)
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  await runDocumentInput(deps, id)
  await repo.patchFields(db, staff, client.documentId, [{ key: 'survey.2_2', value: '見守り等', base: null }])
  const r = await call(`/api/document-inputs/${id}/adopt`, 'POST', { identityConfirmed: true, changes: [
    { key: 'survey.2_4', value: '見守り等', base: null }, { key: 'survey.2_2', value: '一部介助', base: null },
  ] })
  assert.equal(r.status, 409)
  const fields = (await repo.getDocument(db, staff.officeId, client.documentId)).fields
  assert.equal(fields['survey.2_2'].value, '見守り等')
  assert.equal(fields['survey.2_4'], undefined)
  assert.deepEqual((await call(`/api/document-inputs/${id}`)).body.input.adopted, [])
})
test('writer失敗後は読取済みページから再開する。失効した実行は結果を保存しない', { skip }, async () => {
  const client = await repo.createClient(db, staff, { name: '架空 再試行' })
  const id = await uploaded(client.documentId)
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  failWrite = true
  const n = readCalls
  await assert.rejects(runDocumentInput(deps, id), /document_input_retry/)
  assert.equal((await call(`/api/document-inputs/${id}`)).body.input.status, 'queued')
  await runDocumentInput(deps, id)
  assert.equal(readCalls, n + 1)
  assert.equal((await call(`/api/document-inputs/${id}`)).body.input.status, 'review')
  const other = await repo.createClient(db, staff, { name: '架空 リース' })
  const lost = await uploaded(other.documentId)
  await call(`/api/document-inputs/${lost}/complete`, 'POST', {})
  const stale = { ...providers, writer: { write: async (input: Parameters<Providers['writer']['write']>[0]) => {
    await db.query("UPDATE document_inputs SET run_token='new-owner' WHERE id=$1", [lost])
    return providers.writer.write(input)
  } } }
  await runDocumentInput({ ...deps, providers: async () => stale }, lost)
  assert.equal((await call(`/api/document-inputs/${lost}`)).body.input.result, null)
})
test('投入失敗・期限切れを見回りで再投入し、上限回数を超えたものは停止する', { skip }, async () => {
  const client = await repo.createClient(db, staff, { name: '架空 キュー' })
  const id = await uploaded(client.documentId)
  enqueueFails = true
  assert.equal((await call(`/api/document-inputs/${id}/complete`, 'POST', {})).status, 500)
  await db.query("UPDATE document_inputs SET updated_at=now()-interval '3 minutes' WHERE id=$1", [id])
  const found: string[] = []
  await reconcileDocumentInputs(deps, async (id) => { found.push(id) })
  assert.ok(found.includes(id))
  await db.query("UPDATE document_inputs SET attempts=3, status='processing',lease_until=now()-interval '1 minute' WHERE id=$1", [id])
  await reconcileDocumentInputs(deps, async () => {})
  assert.equal((await call(`/api/document-inputs/${id}`)).body.input.status, 'failed')
  assert.equal((await call(`/api/document-inputs/${id}/retry`, 'POST', {})).status, 202)
})

test('原本のハッシュ・MIME・大きさをサーバーでも検証する', { skip }, async () => {
  const made = await repo.createClient(db, staff, { name: '架空 原本検証' })
  const entry = await start(made.documentId)
  const path = documentInputPath(staff.officeId, made.id, entry.input.id)
  const altered = Buffer.from(data)
  altered[altered.length - 1] ^= 1
  await storage.write('source', path, altered)
  assert.equal((await call(`/api/document-inputs/${entry.input.id}/complete`, 'POST', {})).status, 400)
  assert.equal((await call(`/api/document-inputs/${entry.input.id}`)).body.input.status, 'uploading')
  const badMime = await call(`/api/documents/${made.documentId}/inputs`, 'POST', {
    fileName: 'sample.docx', mime: 'application/msword', bytes: 1, sha256: 'a'.repeat(64),
  })
  assert.equal(badMime.status, 400)
  assert.equal((await call(`/api/documents/${made.documentId}/inputs`, 'POST', {
    fileName: 'sample.pdf', mime: 'application/pdf', bytes: 11 * 1024 * 1024, sha256: 'b'.repeat(64),
  })).status, 400)
})

test('別の原本と記載が食い違うと、読取時の値と元の出典・記録日を候補に残す', { skip }, async () => {
  const differentImage = createCanvas(50, 50).toBuffer('image/png')
  const id = await uploaded(doc, differentImage)
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  await runDocumentInput(deps, id)
  const result = (await call(`/api/document-inputs/${id}`)).body.input.result
  const candidate = result.candidates.find((candidate: { key: string }) => candidate.key === 'survey.2_2')
  assert.equal(candidate.base, '見守り等')
  assert.equal(candidate.value, '一部介助')
  assert.equal(candidate.baseSource.fileName, '架空の記入済み書類.png')
  assert.deepEqual(candidate.baseSource.recordedOn, ['2026-11-01'])
  const original = await call(`/api/document-inputs/${candidate.baseSource.inputId}/original`)
  assert.equal(original.status, 200)
})
