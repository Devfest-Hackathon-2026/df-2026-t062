// 書類を作るときに AI が書く（#195）: API → 裏の仕事（worker）→ 書類の値。AI は偽物。DB が要る。
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Db } from '../db/pool.ts'
import type { WorkerDeps } from '../worker/jobs.ts'
import type { AskMeta, Llm } from '../worker/vertex/gemini.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_fill_${process.pid}`

/** 偽の AI が「欄に書く」で書く値（key → 値）。最後の確かめはそのまま返す */
let writes: Record<string, unknown> = {}
/** 「欄に書く」の途中で走らせること（AI が書いている間のケアマネの直しなど） */
let during: (() => Promise<void>) | null = null
let asked: string[] = []

const fakeLlm = (): Llm => ({
  ask: async (_prompt, schema, meta: AskMeta) => {
    asked.push(meta.step)
    const keys = Object.keys((schema as any).properties.fields.properties)
    if (meta.step === '最後の確かめ') return { fields: Object.fromEntries(keys.map((k) => [k, { value: writes[k] ?? null }])) }
    if (during) { const d = during; during = null; await d() }
    return { fields: Object.fromEntries(keys.map((k) => [k, k in writes ? { action: 'write', value: writes[k], from: ['生活の経過'] } : { action: 'skip', value: null, from: [] }])) }
  },
  usage: () => ({ calls: asked.length, promptTokens: 0, cachedTokens: 0, outputTokens: 0, thinkingTokens: 0, yen: 1 }),
})

let db: Db
let origin = ''
let close = async () => {}
const ids = { kai: '', otherClient: '' }
const A = 'Bearer dev:kato@example.com'
const B = 'Bearer dev:other@example.com'

const call = async (path: string, token: string, init: RequestInit = {}) => {
  const res = await fetch(`${origin}${path}`, { ...init, headers: { Authorization: token, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, body: (type.includes('json') ? await res.json() : null) as Record<string, any> }
}

before(async () => {
  if (!url) return
  const { createPool } = await import('../db/pool.ts')
  const root = await createPool({ DATABASE_URL: url })
  await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  await root.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema })
  await (await import('../db/migrate.ts')).migrate(db)
  const forms = await import('../db/forms.ts')
  const { readSeed } = await import('../forms/admin/files.ts')
  await forms.registerVersion(db, readSeed('assessment'), { publish: true })
  await forms.registerVersion(db, readSeed('admission'), { publish: true })
  // 何通も作れる種類にして、テストごとに新しい書類を作る
  await db.query("INSERT INTO form_kinds (key, name, per_client, create_from) VALUES ('fill_admission', '入院時情報提供書', 'many', 'assessment')")
  await forms.registerVersion(db, { ...readSeed('admission'), kind: 'fill_admission' }, { publish: true })
  const { seed } = await import('../db/seed.ts')
  const a = await seed(db)
  const b = await seed(db, { email: 'other@example.com', officeName: 'ほかの事業所' })
  ids.kai = a.clients.kai
  ids.otherClient = b.clients.kai

  const { LocalStorage } = await import('../api/storage.ts')
  const storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-fill-')))
  const f = await import('../worker/fake.ts')
  const workerDeps: WorkerDeps = { db: async () => db, storage: () => storage, providers: async () => ({ stt: new f.FakeStt(), speakers: new f.FakeSpeakers(), formImport: f.fakeFormImport, documentFill: fakeLlm, recording: { summarizer: new f.FakeSummarizer(), writer: new f.FakeTopicWriter() } }) }
  const { LocalQueue } = await import('../api/queue.ts')
  const { runDocumentFill } = await import('../worker/document-fill/job.ts')
  const queue = new LocalQueue(async () => {}, async () => {}, async () => {}, async () => {}, async () => {}, (id) => runDocumentFill(workerDeps, id))
  const { createApiServer } = await import('../api/server.ts')
  const { DevVerifier } = await import('../api/auth.ts')
  const server = createApiServer({ db: async () => db, verifier: () => new DevVerifier(), storage: () => storage, queue: () => queue, devAuth: true })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = async () => {
    await new Promise<void>((r) => server.close(() => r()))
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await db.end()
  }
})

after(async () => close())

beforeEach(() => { writes = {}; during = null; asked = [] })

/** 入院時情報提供書（の様式で、何通も作れる試しの種類）を新しく作る。アセスメントから同じキーを写す */
async function newAdmission() {
  const r = await call(`/api/clients/${ids.kai}/documents`, A, { method: 'POST', body: JSON.stringify({ kind: 'fill_admission' }) })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body.id as string
}

/** AI に頼んで、終わるまで待つ */
async function fill(documentId: string, token = A) {
  const started = await call(`/api/documents/${documentId}/fill`, token, { method: 'POST', body: '{}' })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  for (let i = 0; i < 200; i++) {
    const r = await call(`/api/documents/${documentId}/fill`, token)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    if (!['queued', 'processing'].includes(r.body.fill.status)) return r.body.fill
    await new Promise((res) => setTimeout(res, 30))
  }
  throw new Error('終わらない')
}

const field = async (documentId: string, key: string) =>
  (await db.query('SELECT f.value, f.by, b.kind FROM field_values f LEFT JOIN batches b ON b.id = f.batch_id WHERE f.document_id = $1 AND f.key = $2', [documentId, key])).rows[0]

test('書く: AI が書いた値が、AI の値として書類に入る（書き込みの記録は fill）。仕事は succeeded で、書いた欄の数を返す', { skip }, async () => {
  const doc = await newAdmission()
  writes = { 'person.lifeHistory': '農家に生まれ、定年まで役場に勤めた。', 'housing.notes': '玄関に段差がある。' }
  const r = await fill(doc)
  assert.equal(r.status, 'succeeded')
  assert.equal(r.changes, 2)
  assert.deepEqual(await field(doc, 'person.lifeHistory'), { value: '農家に生まれ、定年まで役場に勤めた。', by: 'ai', kind: 'fill' })
  assert.deepEqual(asked.filter((s) => s === '最後の確かめ').length, 1)
})

test('書く: AI が書いている間にケアマネが直した欄は、上書きしない', { skip }, async () => {
  const doc = await newAdmission()
  writes = { 'person.lifeHistory': 'AI の文。' }
  during = async () => {
    const r = await call(`/api/documents/${doc}/fields`, A, { method: 'PATCH', body: JSON.stringify({ changes: [{ key: 'person.lifeHistory', value: 'ケアマネの文。', base: (await field(doc, 'person.lifeHistory'))?.value ?? null }] }) })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  }
  await fill(doc)
  const f = await field(doc, 'person.lifeHistory')
  assert.deepEqual([f.value, f.by], ['ケアマネの文。', 'cm'])
  assert.notEqual(f.kind, 'fill')
})

test('始める: 動いている間にもう一度押しても、仕事は 1 つ（同じ id を返す）', { skip }, async () => {
  const doc = await newAdmission()
  let release = () => {}
  during = () => new Promise<void>((r) => { release = r })
  writes = { 'housing.notes': '段差あり。' }
  const a = await call(`/api/documents/${doc}/fill`, A, { method: 'POST', body: '{}' })
  const b = await call(`/api/documents/${doc}/fill`, A, { method: 'POST', body: '{}' })
  assert.equal(a.body.fillId, b.body.fillId)
  for (let i = 0; i < 100 && !asked.length; i++) await new Promise((res) => setTimeout(res, 20))
  release()
  for (let i = 0; i < 200; i++) {
    const r = await call(`/api/documents/${doc}/fill`, A)
    if (!['queued', 'processing'].includes(r.body.fill.status)) break
    await new Promise((res) => setTimeout(res, 30))
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM document_fills WHERE document_id = $1', [doc])).rows[0].n, 1)
})

test('始める: ほかの事業所の書類は「無い」。元の書類のない種類（アセスメント）は断る', { skip }, async () => {
  const doc = await newAdmission()
  assert.equal((await call(`/api/documents/${doc}/fill`, B, { method: 'POST', body: '{}' })).status, 404)
  assert.equal((await call(`/api/documents/${doc}/fill`, B)).status, 404)
  const assess = (await db.query("SELECT id FROM documents WHERE client_id = $1 AND kind = 'assessment'", [ids.kai])).rows[0].id
  assert.equal((await call(`/api/documents/${assess}/fill`, A, { method: 'POST', body: '{}' })).status, 409)
})
