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
import { FakeStt, FakeSpeakers, FakeSummarizer, FakeTopicWriter, fakeFormImport } from '../worker/fake.ts'

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
let summaryCalls = 0
let failWrite = false
let enqueueFails = false
const queued: string[] = []
const data = createCanvas(40, 40).toBuffer('image/png')
const providers: Providers = {
  stt: new FakeStt(), speakers: new FakeSpeakers(), formImport: fakeFormImport, recording: { summarizer: new FakeSummarizer(), writer: new FakeTopicWriter() },
  documentWrite: {
    summarizer: { async summarize(input) {
      summaryCalls++
      const entries = input.records![0].scenes[0].entries
      assert.equal(entries.length, 1, '判読不確実な原文は書込処理に渡さない')
      const topic = input.topics.find((topic) => topic.by === 'ai')!.id
      return { texts: { [topic]: entries[0].text }, sourceIds: { [topic]: [entries[0].id] }, usage: ZERO_USAGE }
    } },
    writer: { async write(input) {
      writeCalls++
      if (failWrite) { failWrite = false; throw new Error('Synthetic writer failure') }
      assert.equal(input.sourceKind, '書類')
      assert.ok(input.form.keys.includes('survey.2_2'))
      const cite = { kind: 'summary' as const, ids: [input.summaries[0].id] }
      return { values: {
        'survey.2_2': { value: '一部介助', cite }, 'survey.2_4': { value: '見守り等', cite },
        'survey.2_5': { value: '一部介助', cite: { kind: 'summary' as const, ids: ['unknown-id'] } },
        'unknown.key': { value: '候補外', cite },
      }, usage: ZERO_USAGE, failed: [], incompleteFields: [] }
    } },
  },
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
async function pathOf(id: string) {
  const row = (await db.query('SELECT client_id, upload_generation FROM document_inputs WHERE id=$1', [id])).rows[0]
  return documentInputPath(staff.officeId, row.client_id, id, Number(row.upload_generation))
}
async function uploaded(documentId = doc, bytes: Uint8Array = data) {
  const r = await start(documentId, bytes)
  await storage.writeOnce('source', await pathOf(r.input.id), bytes)
  return r.input.id
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
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
    enqueue: async () => {}, enqueueFormImport: async () => {}, enqueueInspection: async () => {}, enqueueDocumentInput: async (id) => {
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
  const [a, b] = await Promise.all([start(), start()])
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
test('反映先の確認と候補・型を確かめ、保存済みの候補だけを原子的に採用する。別書類には反映しない', { skip }, async () => {
  const id = await uploaded()
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  await runDocumentInput(deps, id)
  const path = `/api/document-inputs/${id}/adopt`
  const input = (await call(`/api/document-inputs/${id}`)).body.input
  const candidate = input.result.candidates.find((c: { key: string }) => c.key === 'survey.2_2')
  assert.equal(candidate.value, '一部介助')
  assert.equal(candidate.base, null)

  assert.equal((await call(path, 'POST', { changes: [{ key: 'survey.2_2', base: null }] })).status, 400, '反映先の確認が要る')
  assert.equal((await call(path, 'POST', { identityConfirmed: true, changes: [{ key: 'survey.2_2', base: null }] })).status, 400, '原本の本人確認を反映先の確認として扱わない')
  assert.equal((await call(path, 'POST', { targetConfirmed: true, changes: [{ key: 'survey.2_2', base: null }] }, 'other@example.com')).status, 404)
  const substituted = await call(path, 'POST', { targetConfirmed: true, changes: [{ key: 'survey.2_2', value: '見守り等', base: null }] })
  assert.equal(substituted.status, 400, 'AI の候補と違う値を原本由来として採用できない')
  assert.match(substituted.body.message, /候補/)
  assert.equal((await repo.getDocument(db, staff.officeId, doc)).fields['survey.2_2'], undefined, '拒否時に値を書かない')
  assert.deepEqual((await call(`/api/document-inputs/${id}`)).body.input.adopted, [])
  assert.equal((await call(path, 'POST', { targetConfirmed: true, changes: [{ key: 'unknown.key', base: null }] })).status, 400)
  assert.equal((await call(path, 'POST', { targetConfirmed: true, changes: [{ key: 'survey.2_2', base: '全介助' }] })).status, 409)
  assert.equal((await call(path, 'POST', { targetConfirmed: true, changes: [{ key: 'survey.2_2', base: null }, { key: 'survey.2_2', base: null }] })).status, 400)

  const onlySelection = await call(path, 'POST', { targetConfirmed: true, changes: [{ key: 'survey.2_2', base: null }] })
  assert.equal(onlySelection.status, 200)
  const field = onlySelection.body.document.fields['survey.2_2']
  assert.equal(field.value, '一部介助', 'サーバーが保存した候補値を反映する')
  assert.equal(field.by, 'cm')
  assert.equal(field.documentSource.inputId, id)
  const reread = (await call(`/api/document-inputs/${id}`)).body.input
  assert.equal(reread.adoptedValues['survey.2_2'], '一部介助', '採用した候補値は画面を開き直しても残る')
  assert.equal(reread.result.candidates[0].value, '一部介助', '評価用の生成候補は改変しない')
  assert.equal(field.documentSource.evidence[0].recordedOn, '2026-11-01')
  assert.equal((await repo.getDocument(db, staff.officeId, sibling)).fields['survey.2_2'], undefined)
  assert.equal((await call(path, 'POST', { targetConfirmed: true, changes: [{ key: 'survey.2_2', base: null }] })).status, 200, '採用の再送は冪等')
})
test('同じ候補を同時に採用しても、1回だけ反映して再送は冪等', { skip }, async () => {
  const client = await repo.createClient(db, staff, { name: '架空 同時採用' })
  const id = await uploaded(client.documentId)
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  await runDocumentInput(deps, id)
  const adopt = () => call(`/api/document-inputs/${id}/adopt`, 'POST', {
    targetConfirmed: true, changes: [{ key: 'survey.2_2', base: null }],
  })
  const [a, b] = await Promise.all([adopt(), adopt()])
  assert.deepEqual([a.status, b.status], [200, 200])
  assert.equal((await repo.getDocument(db, staff.officeId, client.documentId)).fields['survey.2_2'].value, '一部介助')
  const input = (await call(`/api/document-inputs/${id}`)).body.input
  assert.deepEqual(input.adopted, ['survey.2_2'])
  assert.equal(input.adoptedValues['survey.2_2'], '一部介助')
})

test('読取後の人の編集と競合したら、全候補と採用状態をロールバックする', { skip }, async () => {
  const client = await repo.createClient(db, staff, { name: '架空 競合' })
  const id = await uploaded(client.documentId)
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  await runDocumentInput(deps, id)
  await repo.patchFields(db, staff, client.documentId, [{ key: 'survey.2_2', value: '見守り等', base: null }])
  const r = await call(`/api/document-inputs/${id}/adopt`, 'POST', { targetConfirmed: true, changes: [
    { key: 'survey.2_4', value: '見守り等', base: null }, { key: 'survey.2_2', value: '一部介助', base: null },
  ] })
  assert.equal(r.status, 409)
  const fields = (await repo.getDocument(db, staff.officeId, client.documentId)).fields
  assert.equal(fields['survey.2_2'].value, '見守り等')
  assert.equal(fields['survey.2_4'], undefined)
  assert.deepEqual((await call(`/api/document-inputs/${id}`)).body.input.adopted, [])

  // 競合しなかった欄を先に採用してから、同じ原本で残りの候補を更新する。
  const adopt = (changes: { key: string, base: string | null }[]) =>
    call(`/api/document-inputs/${id}/adopt`, 'POST', { targetConfirmed: true, changes })
  assert.equal((await adopt([{ key: 'survey.2_4', base: null }])).status, 200)
  const readsBeforeRefresh = readCalls
  const again = await start(client.documentId)
  assert.equal(again.input.id, id)
  assert.equal(again.uploadUrl, null)
  assert.equal((await call(`/api/document-inputs/${id}/complete`, 'POST', {})).body.input.status, 'queued')
  await runDocumentInput(deps, id)
  assert.equal(readCalls, readsBeforeRefresh, '既に読んだ原本は再度読み取らない')
  const refreshed = (await call(`/api/document-inputs/${id}`)).body.input
  assert.deepEqual(refreshed.adopted, ['survey.2_4'])
  assert.equal(refreshed.result.candidates.find((c: { key: string }) => c.key === 'survey.2_2').base, '見守り等')
  assert.equal((await adopt([{ key: 'survey.2_2', base: '見守り等' }])).status, 200)
})
test('複数印の項目は、別の明瞭な記載やwriterの返答で補わず保留する', { skip }, async () => {
  const client = await repo.createClient(db, staff, { name: '架空 複数印' })
  const before = await repo.getDocument(db, staff.officeId, client.documentId)
  const id = await uploaded(client.documentId)
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  const guarded: Providers = { ...providers, documentRead: () => ({
    ask: async () => ({ entries: [
      { text: '移動は一部介助。特記事項には食事は見守りと記載。', recordedOn: null, region: null, uncertain: false },
      { text: '食事摂取は見守りと一部介助の複数印。', recordedOn: null, region: null, uncertain: true },
    ], issues: ['食事摂取で複数印があるため要確認'] }), usage: () => ZERO_USAGE,
  }) }
  await runDocumentInput({ ...deps, providers: async () => guarded }, id)
  const result = (await call(`/api/document-inputs/${id}`)).body.input.result
  assert.ok(result.candidates.some((candidate: { key: string }) => candidate.key === 'survey.2_2'))
  assert.ok(!result.candidates.some((candidate: { key: string }) => candidate.key === 'survey.2_4'))
  assert.ok(result.incompleteFields.includes('survey.2_4'))
  assert.deepEqual((await repo.getDocument(db, staff.officeId, client.documentId)).fields, before.fields)
})
test('writer失敗後は読取済みページから再開する。失効した実行は結果を保存しない', { skip }, async () => {
  const client = await repo.createClient(db, staff, { name: '架空 再試行' })
  const id = await uploaded(client.documentId)
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  failWrite = true
  const n = readCalls
  const summarized = summaryCalls
  await assert.rejects(runDocumentInput(deps, id), /document_input_retry/)
  assert.equal((await call(`/api/document-inputs/${id}`)).body.input.status, 'queued')
  await runDocumentInput(deps, id)
  assert.equal(readCalls, n + 1)
  assert.equal(summaryCalls, summarized + 1, '再試行でも要約を作り直さない')
  assert.equal((await call(`/api/document-inputs/${id}`)).body.input.status, 'review')
  const other = await repo.createClient(db, staff, { name: '架空 リース' })
  const lost = await uploaded(other.documentId)
  await call(`/api/document-inputs/${lost}/complete`, 'POST', {})
  const stale = { ...providers, documentWrite: { ...providers.documentWrite!, writer: { write: async (input: Parameters<NonNullable<Providers['documentWrite']>['writer']['write']>[0]) => {
    await db.query("UPDATE document_inputs SET run_token='new-owner' WHERE id=$1", [lost])
    return providers.documentWrite!.writer.write(input)
  } } } }
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

test('原本のハッシュ・MIME・大きさを確かめ、失敗した送信は同じファイルで送り直せる', { skip }, async () => {
  const made = await repo.createClient(db, staff, { name: '架空 原本検証' })
  const complete = (id: string) => call(`/api/document-inputs/${id}/complete`, 'POST', {})
  const body = (bytes: Uint8Array) => ({
    fileName: '架空の記入済み書類.png', mime: 'image/png' as const, bytes: bytes.length, sha256: sha(bytes),
  })

  // 大きさは合うがハッシュが違う: 壊れた原本を残さず、同じファイルを別の場所へ送り直せる
  const entry = await start(made.documentId)
  const firstPath = await pathOf(entry.input.id)
  const altered = Buffer.from(data)
  altered[altered.length - 1] ^= 1
  await storage.write('source', firstPath, altered)
  assert.equal((await complete(entry.input.id)).status, 400)
  assert.equal((await call(`/api/document-inputs/${entry.input.id}`)).body.input.status, 'uploading')
  const retried = await start(made.documentId)
  assert.equal(retried.input.id, entry.input.id)
  assert.ok(retried.uploadUrl)
  assert.notEqual(retried.uploadUrl, entry.uploadUrl)
  const secondPath = await pathOf(entry.input.id)
  assert.notEqual(secondPath, firstPath, '前の送信と混ざらない場所に送る')
  await storage.writeOnce('source', secondPath, data)
  assert.equal((await complete(entry.input.id)).status, 202)
  assert.equal((await call(`/api/document-inputs/${entry.input.id}`)).body.input.status, 'queued')
  const again = await start(made.documentId)
  assert.equal(again.input.id, entry.input.id)
  assert.equal(again.uploadUrl, null, '正常に送れた原本は送り直さない')
  assert.equal((await complete(entry.input.id)).status, 202, '完了の再送は冪等')

  // MIME の署名が違う: ハッシュが合っていても採用しない
  const wrongSignature = Buffer.from(data)
  wrongSignature[1] ^= 1
  const first = await call(`/api/documents/${made.documentId}/inputs`, 'POST', body(wrongSignature))
  assert.equal(first.status, 201)
  await storage.writeOnce('source', await pathOf(first.body.input.id), wrongSignature)
  assert.equal((await complete(first.body.input.id)).status, 400)
  const mimeRetry = await call(`/api/documents/${made.documentId}/inputs`, 'POST', body(wrongSignature))
  assert.ok(mimeRetry.body.uploadUrl, '中身が種類と合わないファイルも、送り直せる URL を返す')
  assert.notEqual(mimeRetry.body.uploadUrl, first.body.uploadUrl)
  assert.equal((await call(`/api/document-inputs/${first.body.input.id}`)).body.input.status, 'uploading')

  // 途中までしか届いていない（大きさが違う）: 部分的な原本を残さない
  const partialBytes = createCanvas(60, 60).toBuffer('image/png')
  const partialEntry = await call(`/api/documents/${made.documentId}/inputs`, 'POST', body(partialBytes))
  assert.equal(partialEntry.status, 201)
  await storage.writeOnce('source', await pathOf(partialEntry.body.input.id), partialBytes.subarray(0, 10))
  assert.equal((await complete(partialEntry.body.input.id)).status, 409)
  const partialRetry = await call(`/api/documents/${made.documentId}/inputs`, 'POST', body(partialBytes))
  assert.ok(partialRetry.body.uploadUrl)
  await storage.writeOnce('source', await pathOf(partialEntry.body.input.id), partialBytes)
  assert.equal((await complete(partialEntry.body.input.id)).status, 202)

  // 送信期限が切れた URL は、まだ何も届いていなければ同じ場所で作り直せる
  const expiredBytes = createCanvas(70, 70).toBuffer('image/png')
  const expired = await call(`/api/documents/${made.documentId}/inputs`, 'POST', body(expiredBytes))
  assert.ok(expired.body.uploadUrl)
  const renewed = await call(`/api/documents/${made.documentId}/inputs`, 'POST', { ...body(expiredBytes), expiredUploadUrl: expired.body.uploadUrl })
  assert.notEqual(renewed.body.uploadUrl, expired.body.uploadUrl)
  await storage.writeOnce('source', await pathOf(expired.body.input.id), expiredBytes)
  assert.equal((await complete(expired.body.input.id)).status, 202)

  const badMime = await call(`/api/documents/${made.documentId}/inputs`, 'POST', {
    fileName: 'sample.docx', mime: 'application/msword', bytes: 1, sha256: 'a'.repeat(64),
  })
  assert.equal(badMime.status, 400)
  assert.equal((await call(`/api/documents/${made.documentId}/inputs`, 'POST', {
    fileName: 'sample.pdf', mime: 'application/pdf', bytes: 11 * 1024 * 1024, sha256: 'b'.repeat(64),
  })).status, 400)
})

test('別の原本と記載が食い違うと、読取時の値と元の出典・記録日を候補に残す', { skip }, async () => {
  const client = await repo.createClient(db, staff, { name: '架空 出典' })
  const first = await uploaded(client.documentId)
  await call(`/api/document-inputs/${first}/complete`, 'POST', {})
  const previous: Providers = { ...providers, documentWrite: { ...providers.documentWrite!, writer: { async write(input) {
    const written = await providers.documentWrite!.writer.write(input)
    written.values['survey.2_2'].value = '見守り等'
    return written
  } } } }
  await runDocumentInput({ ...deps, providers: async () => previous }, first)
  assert.equal((await call(`/api/document-inputs/${first}/adopt`, 'POST', {
    targetConfirmed: true, changes: [{ key: 'survey.2_2', base: null }],
  })).status, 200)

  const differentImage = createCanvas(50, 50).toBuffer('image/png')
  const id = await uploaded(client.documentId, differentImage)
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  await runDocumentInput(deps, id)
  const result = (await call(`/api/document-inputs/${id}`)).body.input.result
  const candidate = result.candidates.find((candidate: { key: string }) => candidate.key === 'survey.2_2')
  assert.equal(candidate.base, '見守り等')
  assert.equal(candidate.value, '一部介助')
  assert.equal(candidate.baseSource.fileName, '架空の記入済み書類.png')
  assert.deepEqual(candidate.baseSource.recordedOn, ['2026-11-01'])
  assert.equal(candidate.baseSource.inputId, first)
  const original = await call(`/api/document-inputs/${candidate.baseSource.inputId}/original`)
  assert.equal(original.status, 200)
})

test('期限切れURLの同時更新と遅着した旧送信が、新しい送信・原本を壊さない', { skip }, async () => {
  const client = await repo.createClient(db, staff, { name: '架空 遅着送信' })
  const first = await start(client.documentId)
  const body = { fileName: '架空.png', mime: 'image/png', bytes: data.length, sha256: sha(data), expiredUploadUrl: first.uploadUrl }
  const renew = () => call(`/api/documents/${client.documentId}/inputs`, 'POST', body)
  const [a, b] = await Promise.all([renew(), renew()])
  assert.deepEqual([a.status, b.status], [201, 201])
  assert.equal(a.body.uploadUrl, b.body.uploadUrl)
  assert.notEqual(a.body.uploadUrl, first.uploadUrl)
  const corrupted = Buffer.from(data)
  corrupted[corrupted.length - 1] ^= 1
  assert.equal((await storage.receive(first.uploadUrl!.split('/').at(-1)!, undefined, corrupted)).status, 200)
  assert.equal((await storage.receive(a.body.uploadUrl.split('/').at(-1)!, undefined, data)).status, 200)
  const complete = () => call(`/api/document-inputs/${first.input.id}/complete`, 'POST', {})
  assert.deepEqual((await Promise.all([complete(), complete()])).map((r) => r.status), [202, 202])
  assert.deepEqual(Buffer.from(await storage.read('source', await pathOf(first.input.id))), data)
  assert.equal((await start(client.documentId)).uploadUrl, null)
})

test('保存候補でも型不正・根拠IDの欠落・不確実な根拠は採用しない', { skip }, async () => {
  const client = await repo.createClient(db, staff, { name: '架空 候補検証' })
  const id = await uploaded(client.documentId)
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  await runDocumentInput(deps, id)
  const original = (await call(`/api/document-inputs/${id}`)).body.input.result
  for (const mode of ['invalid_type', 'unknown_cite', 'uncertain'] as const) {
    const result = structuredClone(original)
    if (mode === 'invalid_type') result.candidates[0].value = 123
    if (mode === 'unknown_cite') result.candidates[0].cite.push('unknown-id')
    if (mode === 'uncertain') result.evidence[0].uncertain = true
    await db.query('UPDATE document_inputs SET result=$2 WHERE id=$1', [id, JSON.stringify(result)])
    const response = await call(`/api/document-inputs/${id}/adopt`, 'POST', { targetConfirmed: true, changes: [{ key: 'survey.2_2', base: null }] })
    assert.equal(response.status, 400, mode)
    assert.equal((await repo.getDocument(db, staff.officeId, client.documentId)).fields['survey.2_2'], undefined)
    assert.deepEqual((await call(`/api/document-inputs/${id}`)).body.input.adopted, [])
  }
})

test('読取後に様式の版が変わった候補は採用せず、同じ原本を今の版で読み取り直せる', { skip }, async () => {
  const forms = await import('../db/forms.ts')
  const { readSeed } = await import('../forms/admin/files.ts')
  const client = await repo.createClient(db, staff, { name: '架空 版整合' })
  const id = await uploaded(client.documentId)
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  await runDocumentInput(deps, id)
  const readVersion = (await db.query('SELECT template_version_id FROM document_inputs WHERE id=$1', [id])).rows[0].template_version_id
  assert.ok(readVersion)
  assert.equal(readVersion, (await db.query('SELECT template_version_id FROM documents WHERE id=$1', [client.documentId])).rows[0].template_version_id)

  const seed = readSeed('assessment')
  const changed = await forms.registerVersion(db, {
    ...seed, bindings: {
      ...seed.bindings,
      // 同じkeyのまま、印字欄に対応する選択肢の意味を入れ替えた版でも拒否する。
      'p6_2-2_1': seed.bindings['p6_2-2_3'],
      'p6_2-2_3': seed.bindings['p6_2-2_1'],
    },
    pages: seed.pages.map((page) => ({ ...page, title: `${page.title} ` })),
  }, { publish: true })
  await db.query('UPDATE documents SET template_version_id=$2,updated_at=now() WHERE id=$1', [client.documentId, changed.versionId])
  const path = `/api/document-inputs/${id}/adopt`
  const conflict = await call(path, 'POST', { targetConfirmed: true, changes: [{ key: 'survey.2_2', base: null }] })
  assert.equal(conflict.status, 409)
  assert.match(conflict.body.message, /様式の版/)
  assert.equal((await repo.getDocument(db, staff.officeId, client.documentId)).fields['survey.2_2'], undefined, '拒否時に値を書かない')

  // 同じファイルを選び直すと、古い候補を消して今の版で読み取り直す（原本は送り直さない）
  const again = await start(client.documentId)
  assert.equal(again.input.id, id)
  assert.equal(again.uploadUrl, null)
  assert.equal((await call(`/api/document-inputs/${id}`)).body.input.status, 'queued')
  await runDocumentInput(deps, id)
  assert.equal((await call(`/api/document-inputs/${id}`)).body.input.status, 'review')
  assert.equal((await call(path, 'POST', { targetConfirmed: true, changes: [{ key: 'survey.2_2', base: null }] })).status, 200)
})

test('開始後に版を移してもworkerは開始時の版を使い、既存の版不明候補も採用しない', { skip }, async () => {
  const forms = await import('../db/forms.ts')
  const { readSeed } = await import('../forms/admin/files.ts')
  const client = await repo.createClient(db, staff, { name: '架空 開始時の版' })
  const id = await uploaded(client.documentId)
  const original = (await repo.getDocument(db, staff.officeId, client.documentId)).formVersionId
  const seed = readSeed('assessment')
  const changed = await forms.registerVersion(db, { ...seed, pages: seed.pages.map((p) => ({ ...p, title: `${p.title}（別版）` })) }, { publish: true })
  await db.query('UPDATE documents SET template_version_id=$2 WHERE id=$1', [client.documentId, changed.versionId])
  await call(`/api/document-inputs/${id}/complete`, 'POST', {})
  await runDocumentInput(deps, id)
  assert.equal((await db.query('SELECT template_version_id FROM document_inputs WHERE id=$1', [id])).rows[0].template_version_id, original)
  const adopt = () => call(`/api/document-inputs/${id}/adopt`, 'POST', { targetConfirmed: true, changes: [{ key: 'survey.2_2', base: null }] })
  assert.equal((await adopt()).status, 409)
  await db.query('UPDATE document_inputs SET template_version_id=NULL WHERE id=$1', [id])
  assert.equal((await adopt()).status, 409, '移行前の版不明候補を現在の版だったと推測しない')
  await start(client.documentId)
  await runDocumentInput(deps, id)
  assert.equal((await adopt()).status, 200)
})
