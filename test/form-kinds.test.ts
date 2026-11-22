// 書類の種類を form_kinds の行で動かす（#108、docs/再設計/16_書類と点検の基盤.md の「書類の種類ごとの動き」「書類を作る」）。
// コードは種類の名前を知らない: 行を足すだけで新しい種類の書類を作れる。api と DB を通しで確かめる。
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Db } from '../db/pool.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_kinds_${process.pid}`
let db: Db
let origin = ''
let close = async () => {}
const ids = { officeA: '', clientA: '', clientB: '' }
const CARE = 'Bearer dev:kato@example.com'
const OTHER = 'Bearer dev:other@example.com'

const call = async (path: string, init: RequestInit & { token?: string } = {}) => {
  const res = await fetch(`${origin}${path}`, { ...init, headers: { Authorization: init.token ?? CARE, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, body: (type.includes('json') ? await res.json() : null) as any }
}
const post = (path: string, body: object, token?: string) => call(path, { method: 'POST', body: JSON.stringify(body), token })

/** 全体の様式（試しの種類）。氏名・事業所名・その様式だけの欄を読む */
async function registerGlobal(kind: string) {
  const { registerVersion } = await import('../db/forms.ts')
  const slot = (name: string, y: number) => ({ name, type: 'text' as const, position: { x: 20, y }, width: 60, height: 8 })
  return registerVersion(db, {
    kind, name: `${kind} の様式`, title: kind, officeId: null, basePdfSha256: 'a'.repeat(64),
    schemas: [[slot('氏名', 20), slot('事業所', 30), slot('住所', 40)]],
    bindings: {
      氏名: { op: 'text@1', ui: 'text', ref: { key: 'person.name' } },
      事業所: { op: 'text@1', ui: 'text', ref: { key: 'office.name' } },
      住所: { op: 'text@1', ui: 'text', ref: { key: 'person.address' } },
    },
    pages: [{ no: 1, pdfIndex: 0, title: '1 ページ', width: 210, height: 297 }],
  }, { publish: true })
}

before(async () => {
  if (!url) return
  const { createPool } = await import('../db/pool.ts')
  const root = await createPool({ DATABASE_URL: url })
  await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  await root.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema })
  await (await import('../db/migrate.ts')).migrate(db)
  const { seed } = await import('../db/seed.ts')
  const a = await seed(db)
  const b = await seed(db, { email: 'other@example.com', officeName: 'ほかの事業所' })
  Object.assign(ids, { officeA: a.officeId, clientA: a.clients.sato, clientB: b.clients.sato })

  const { createApiServer } = await import('../api/server.ts')
  const { DevVerifier, DevAccounts } = await import('../api/auth.ts')
  const { LocalStorage } = await import('../api/storage.ts')
  const storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-kinds-')))
  const server = createApiServer({ db: async () => db, verifier: () => new DevVerifier(), storage: () => storage, queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }), devAuth: true, accounts: () => new DevAccounts() })
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

test('GET /api/form-kinds: 種類と、その事業所で使える様式があるか（主な書類が先）', { skip }, async () => {
  const r = await call('/api/form-kinds')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.kinds.map((k: any) => [k.key, k.name, k.isPrimary, k.perClient, k.createFrom, k.available]), [
    ['assessment', 'アセスメント', true, 'one', null, true],
    ['admission', '入院時情報提供書', false, 'one', 'assessment', true],
    // 第1〜3表は #90 で足した。全体の様式をまだ登録していないので、ここでは使えない
    ['care_plan_1', '居宅サービス計画書 第1表', false, 'many', 'assessment', true],
    ['care_plan_2', '居宅サービス計画書 第2表', false, 'many', null, true],
    ['care_plan_3', '週間サービス計画表 第3表', false, 'many', null, true],
    ['care_plan_4', 'サービス担当者会議の要点 第4表', false, 'many', 'assessment', true],
    ['care_plan_5', '居宅介護支援経過 第5表', false, 'many', 'assessment', true],
    ['care_plan_6', 'サービス利用票 第6表', false, 'many', 'assessment', true],
  ])
  const { REQUIRED_ASSESS } = await import('../core/fields.ts')
  assert.deepEqual(r.body.kinds[0].required, REQUIRED_ASSESS, '必須の欄は form_kinds.required（最初の行は fields.json の required.assess と同じ）')
  assert.deepEqual(r.body.kinds[1].required, [])
  // 行を足すと出る。様式がまだなければ使えない
  await db.query("INSERT INTO form_kinds (key, name, per_client, create_from) VALUES ('kindtest', '試しの書類', 'many', 'assessment')")
  const added = (await call('/api/form-kinds')).body.kinds.find((k: any) => k.key === 'kindtest')
  assert.deepEqual([added.name, added.perClient, added.available], ['試しの書類', 'many', false])
})

test('利用者を作ると主な書類も作り、応答は documentId。一覧の必須の欄の数は、主な書類の種類の required から数える', { skip }, async () => {
  const made = await post('/api/clients', { name: '種類の見本' })
  assert.equal(made.status, 201)
  assert.ok(made.body.documentId)
  assert.equal(made.body.assessmentId, undefined)
  const detail = (await call(`/api/clients/${made.body.id}`)).body.client
  assert.deepEqual(detail.documents.map((d: any) => [d.id, d.kind]), [[made.body.documentId, 'assessment']])
  const row = () => call('/api/clients').then((r) => r.body.clients.find((c: any) => c.id === made.body.id))
  assert.equal((await row()).documentId, made.body.documentId)
  assert.equal((await row()).required.total, 84, 'アセスメントの必須の欄は 84 組（要介護度と見込みの要介護度で 1 組）')
  // 必須の欄を行で変えると、数え方も変わる（コードは fields.json の required を読まない）
  const before = (await db.query("SELECT required FROM form_kinds WHERE key = 'assessment'")).rows[0].required
  await db.query(`UPDATE form_kinds SET required = '["person.name", ["cert.careLevel", "cert.expectedCareLevel"]]' WHERE key = 'assessment'`)
  try {
    assert.deepEqual((await row()).required, { filled: 1, total: 2 })
  } finally {
    await db.query('UPDATE form_kinds SET required = $1 WHERE key = \'assessment\'', [JSON.stringify(before)])
  }
})

test('POST /api/clients/:id/documents {kind}: 行を足すだけで新しい種類の書類を作れる。create_from の書類から同じ key を写し、事業所の設定を入れる。何通も作れる種類は seq が増える', { skip }, async () => {
  await db.query("INSERT INTO form_kinds (key, name, per_client, create_from) VALUES ('kindmany', '何通もの書類', 'many', 'assessment') ON CONFLICT DO NOTHING")
  await registerGlobal('kindmany')
  const assess = (await call(`/api/clients/${ids.clientA}`)).body.client.documents.find((d: any) => d.kind === 'assessment')
  const doc = (await call(`/api/documents/${assess.id}`)).body.document
  const r = await call(`/api/documents/${assess.id}/fields`, { method: 'PATCH', body: JSON.stringify({ changes: [{ key: 'person.address', value: '見本市 1-1', base: doc.fields['person.address']?.value ?? null }] }) })
  assert.equal(r.status, 200)

  const first = await post(`/api/clients/${ids.clientA}/documents`, { kind: 'kindmany' })
  assert.equal(first.status, 201)
  assert.deepEqual([first.body.kind, first.body.created], ['kindmany', true])
  const second = await post(`/api/clients/${ids.clientA}/documents`, { kind: 'kindmany' })
  assert.equal(second.status, 201, '何通も作れる種類は、もう 1 通作る')
  assert.notEqual(second.body.id, first.body.id)
  const seqs = (await db.query("SELECT seq FROM documents WHERE client_id = $1 AND kind = 'kindmany' ORDER BY seq", [ids.clientA])).rows.map((x) => x.seq)
  assert.deepEqual(seqs, [1, 2])

  const made = (await call(`/api/documents/${first.body.id}`)).body.document
  assert.equal(made.kind, 'kindmany')
  assert.equal(made.fields['person.address'].value, '見本市 1-1', 'アセスメントから写した')
  assert.equal(made.fields['person.address'].by, 'ai', '写した値は AI の値')
  assert.equal(made.fields['office.name'].value, 'みほん居宅介護支援事業所', '事業所の設定')
  assert.equal(made.batches[0].kind, 'copy')
  assert.equal(made.batches[0].label, 'AI 書き込み・アセスメントから写した')
  assert.equal(made.fields['person.phone'], undefined, '様式の版が読まない欄は写さない')
})

test('1 人 1 通の種類は、2 回目は今の書類を返す。種類がなければ 400、様式がなければ 404、ほかの事業所の利用者は 404', { skip }, async () => {
  const a = await post(`/api/clients/${ids.clientA}/documents`, { kind: 'admission' })
  assert.deepEqual([a.status, a.body.created], [201, true])
  const again = await post(`/api/clients/${ids.clientA}/documents`, { kind: 'admission' })
  assert.deepEqual([again.status, again.body.id, again.body.created], [200, a.body.id, false])
  assert.equal((await post(`/api/clients/${ids.clientA}/documents`, { kind: 'nothing' })).status, 400)
  assert.equal((await post(`/api/clients/${ids.clientA}/documents`, { form: 'admission' })).status, 400, '本文は {kind}')
  await db.query("INSERT INTO form_kinds (key, name) VALUES ('noform', '様式のない書類') ON CONFLICT DO NOTHING")
  assert.equal((await post(`/api/clients/${ids.clientA}/documents`, { kind: 'noform' })).status, 404)
  assert.equal((await post(`/api/clients/${ids.clientB}/documents`, { kind: 'admission' })).status, 404)
})

test('録音は、録音を始めた書類につなぐ（documentId）。省けば主な書類。ほかの利用者の書類は 404', { skip }, async () => {
  const docs = (await call(`/api/clients/${ids.clientA}`)).body.client.documents
  const adm = docs.find((d: any) => d.kind === 'admission') ?? (await post(`/api/clients/${ids.clientA}/documents`, { kind: 'admission' })).body
  const primary = docs.find((d: any) => d.kind === 'assessment')
  const start = (body: object) => post(`/api/clients/${ids.clientA}/recordings/resumable`, { mime: 'audio/webm', ...body })
  const withDoc = await start({ documentId: adm.id })
  assert.equal(withDoc.status, 201)
  assert.equal((await db.query('SELECT document_id FROM recordings WHERE id = $1', [withDoc.body.recordingId])).rows[0].document_id, adm.id)
  const plain = await start({})
  assert.equal((await db.query('SELECT document_id FROM recordings WHERE id = $1', [plain.body.recordingId])).rows[0].document_id, primary.id)
  const otherDoc = (await call(`/api/clients/${ids.clientB}`, { token: OTHER })).body.client.documents[0].id
  assert.equal((await start({ documentId: otherDoc })).status, 404)
})
