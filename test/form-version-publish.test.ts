// 様式の下書きを確かめる・直す・捨てる・試し印字・公開する（#103 の 2 本目）。api・DB・置き場を通しで確かめる。
// 下書きは、取り込みのジョブが作るのと同じ形で DB に直接作る（変換は test/form-import-job.test.ts）。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { generate } from '@pdfme/generator'
import { text, rectangle } from '@pdfme/schemas'
import type { Storage } from '../api/storage.ts'
import type { Db } from '../db/pool.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_fpublish_${process.pid}`
const font = { BIZUDPGothic: { data: readFileSync(new URL('../forms/fonts/BIZUDPGothic-Regular.ttf', import.meta.url)), fallback: true, subset: true } }
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

let db: Db
let storage: Storage
let origin = ''
let close = async () => {}
const ids = { officeA: '', officeB: '', globalAdmission: '' }
const CARE_A = 'Bearer dev:kato@example.com'
const ADMIN_A = 'Bearer dev:admin-a@example.com'
const ADMIN_B = 'Bearer dev:admin-b@example.com'
const SITE = 'Bearer dev:site@example.com'

const call = async (path: string, token: string, init: RequestInit = {}) => {
  const res = await fetch(`${origin}${path}`, { ...init, headers: { Authorization: token, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, type, body: (type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer())) as any }
}

const slot = (name: string, y: number) => ({
  name, type: 'text', content: '', position: { x: 61, y }, width: 38, height: 8,
  fontName: 'BIZUDPGothic', fontSize: 10, alignment: 'left', verticalAlignment: 'middle', lineHeight: 1, characterSpacing: 0, fontColor: '#1a3fa0',
})
const DRAFT = {
  schemas: [[slot('p1_氏名', 31), slot('p1_開催場所', 51)]],
  bindings: {
    p1_氏名: { op: 'text@1', ui: 'text', ref: { key: 'person.name' } },
    p1_開催場所: { op: 'text@1', ui: 'text', ref: { key: 'local.meetingPlace' } },
  },
  pages: [{ no: 1, pdfIndex: 0, title: '1 ページ', width: 210, height: 297 }],
  localFields: [{ key: 'local.meetingPlace', label: '開催場所', type: 'text' }],
  review: [],
}

let pdfCount = 0
/** 架空の白紙の用紙（呼ぶたびに別の PDF） */
async function formPdf(): Promise<Uint8Array> {
  pdfCount++
  const t = { name: 'label', type: 'text', position: { x: 20, y: 32 }, width: 40, height: 8, fontName: 'BIZUDPGothic', fontSize: 12, alignment: 'left', verticalAlignment: 'top', lineHeight: 1, characterSpacing: 0, fontColor: '#000000', content: '' }
  const r = { name: 'box', type: 'rectangle', position: { x: 60, y: 30 }, width: 40, height: 10, borderWidth: 0.3, borderColor: '#000000', color: '', readOnly: true, content: '' }
  return new Uint8Array(await generate({ template: { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[r, t]] } as never, inputs: [{ label: `氏名 ${pdfCount}` }], plugins: { text, rectangle }, options: { font } }))
}

/** 取り込みのジョブが作るのと同じ下書きの版を作る（元の PDF も様式の場所に置く）。置かないときは withPdf: false */
async function makeDraft(officeId: string | null, kind: string, opts: { withPdf?: boolean } = {}): Promise<string> {
  const imports = await import('../db/form-imports.ts')
  const { basePdfAssetPath } = await import('../core/form.ts')
  const pdf = await formPdf()
  if (opts.withPdf !== false) await storage.write('forms', basePdfAssetPath(sha(pdf), officeId), pdf, 'application/pdf')
  const imp = await imports.createImport(db, { officeId }, kind, null)
  await db.query('UPDATE form_imports SET uploaded_at = now() WHERE id = $1', [imp.id])
  const claimed = (await imports.claimImport(db, imp.id, 'test'))!
  return (await imports.finishWithDraft(db, claimed, 'test', sha(pdf), DRAFT as never))!
}

const get = (prefix: string, id: string, token: string) => call(`${prefix}/form-versions/${id}`, token)
const patch = (prefix: string, id: string, token: string, b: object) => call(`${prefix}/form-versions/${id}`, token, { method: 'PATCH', body: JSON.stringify(b) })
const publish = (prefix: string, id: string, token: string, base: string) => call(`${prefix}/form-versions/${id}/publish`, token, { method: 'POST', body: JSON.stringify({ base }) })

before(async () => {
  if (!url) return
  const { createPool } = await import('../db/pool.ts')
  const root = await createPool({ DATABASE_URL: url })
  await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  await root.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema })
  await (await import('../db/migrate.ts')).migrate(db)
  const { seed } = await import('../db/seed.ts')
  ids.officeA = (await seed(db)).officeId
  ids.officeB = (await seed(db, { email: 'other@example.com', officeName: 'ほかの事業所' })).officeId
  for (const [office, email] of [[ids.officeA, 'admin-a@example.com'], [ids.officeB, 'admin-b@example.com']]) {
    await db.query("INSERT INTO staff (office_id, auth_uid, name, email, role) VALUES ($1, $2, '責任者', $3, 'admin')", [office, `dev:${email}`, email])
  }
  await db.query("INSERT INTO site_admins (auth_uid, name, email) VALUES ('dev:site@example.com', 'サイト管理者', 'site@example.com')")
  const forms = await import('../db/forms.ts')
  ids.globalAdmission = await forms.publishedVersionId(db, ids.officeA, 'admission')

  process.env.PUBLIC_API_ORIGIN = ''
  const { LocalStorage } = await import('../api/storage.ts')
  storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-fpublish-')))
  const { createApiServer } = await import('../api/server.ts')
  const { DevVerifier } = await import('../api/auth.ts')
  const server = createApiServer({ db: async () => db, verifier: () => new DevVerifier(), storage: () => storage, queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }), devAuth: true })
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

test('下書きは責任者の入口で読める（直す前の確かめつき）。ケアマネの入口・ほかの事業所・全体の入口からは 404', { skip }, async () => {
  const id = await makeDraft(ids.officeA, 'assessment')
  const r = await get('/api/office', id, ADMIN_A)
  assert.equal(r.status, 200)
  assert.equal(r.body.formVersion.status, 'draft')
  assert.equal(r.body.formVersion.global, false)
  assert.deepEqual(r.body.formVersion.localFields, DRAFT.localFields)
  assert.deepEqual(r.body.problems, [])
  assert.equal((await call(`/api/form-versions/${id}`, CARE_A)).status, 404, '下書きは書類から指せないので、ケアマネの入口からは見えない')
  assert.equal((await call(`/api/form-versions/${id}`, ADMIN_A)).status, 404, '責任者でも、ケアマネの入口からは見えない')
  assert.equal((await get('/api/office', id, ADMIN_B)).status, 404)
  assert.equal((await get('/api/admin', id, SITE)).status, 404)
  const assets = await call(`/api/office/form-versions/${id}/assets`, ADMIN_A)
  assert.deepEqual([assets.status, assets.body.hasPdf], [200, true])
})

test('下書きを直す: 元にした中身の指紋が違えば 409。形が違えば 400。直すと指紋が変わる', { skip }, async () => {
  const id = await makeDraft(ids.officeA, 'assessment')
  const before = (await get('/api/office', id, ADMIN_A)).body.formVersion
  assert.equal((await patch('/api/office', id, ADMIN_A, { base: 'f'.repeat(64), localFields: [] })).status, 409)
  assert.equal((await patch('/api/office', id, ADMIN_A, { base: before.contentSha })).status, 400, '直す中身がない')
  assert.equal((await patch('/api/office', id, ADMIN_A, { base: before.contentSha, localFields: [{ key: 'notlocal', label: 'x', type: 'text' }] })).status, 400)
  const moved = { ...DRAFT.schemas[0][0], position: { x: 62, y: 31 } }
  const r = await patch('/api/office', id, ADMIN_A, { base: before.contentSha, schemas: [[moved, DRAFT.schemas[0][1]]] })
  assert.equal(r.status, 200)
  assert.notEqual(r.body.formVersion.contentSha, before.contentSha)
  assert.deepEqual(r.body.formVersion.schemas[0][0].position, { x: 62, y: 31 })
  assert.deepEqual(r.body.formVersion.bindings, before.bindings, '送らなかった部分はそのまま')
  // 古い指紋で直そうとすると 409（ほかの人が先に直した）
  assert.equal((await patch('/api/office', id, ADMIN_A, { base: before.contentSha, localFields: [] })).status, 409)
})

test('試し印字: 架空の値で印字した PDF。元の PDF が置き場になければ 503', { skip }, async () => {
  const id = await makeDraft(ids.officeA, 'assessment')
  const r = await call(`/api/office/form-versions/${id}/preview`, ADMIN_A, { method: 'POST' })
  assert.equal(r.status, 200)
  assert.equal(r.type, 'application/pdf')
  assert.equal(new TextDecoder().decode(r.body.slice(0, 5)), '%PDF-')
  const noPdf = await makeDraft(ids.officeA, 'assessment', { withPdf: false })
  assert.equal((await call(`/api/office/form-versions/${noPdf}/preview`, ADMIN_A, { method: 'POST' })).status, 503)
})

test('公開: 確かめが通らなければ 422 と理由。通れば公開し、その事業所の新しい書類から使う。今の書類とほかの事業所は前の版のまま。公開した版は直せない・捨てられない', { skip }, async () => {
  const id = await makeDraft(ids.officeA, 'assessment')
  let v = (await get('/api/office', id, ADMIN_A)).body.formVersion
  // 対応のない印字欄を足すと、公開できない
  v = (await patch('/api/office', id, ADMIN_A, { base: v.contentSha, schemas: [[...v.schemas[0], slot('p1_対応なし', 71)]] })).body.formVersion
  const ng = await publish('/api/office', id, ADMIN_A, v.contentSha)
  assert.equal(ng.status, 422)
  assert.deepEqual(ng.body.problems, ['p1_対応なし: 印字欄に対応がない'])
  // 元の PDF がなければ公開できない（架空の値で印字できない）
  const noPdf = await makeDraft(ids.officeA, 'assessment', { withPdf: false })
  const noPdfBase = (await get('/api/office', noPdf, ADMIN_A)).body.formVersion.contentSha
  assert.deepEqual((await publish('/api/office', noPdf, ADMIN_A, noPdfBase)).body.problems, ['元の PDF が置き場にない'])
  // 直して公開する。確かめたあとに直されていたら 409
  v = (await patch('/api/office', id, ADMIN_A, { base: v.contentSha, schemas: DRAFT.schemas })).body.formVersion
  assert.equal((await publish('/api/office', id, ADMIN_A, 'a'.repeat(64))).status, 409)

  const existing = (await db.query("SELECT d.template_version_id FROM documents d JOIN clients c ON c.id = d.client_id WHERE c.office_id = $1 AND d.kind = 'assessment' LIMIT 1", [ids.officeA])).rows[0].template_version_id
  const ok = await publish('/api/office', id, ADMIN_A, v.contentSha)
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.formVersion.status, 'published')

  // その事業所の新しい書類は、事業所の様式を使う。ほかの事業所は全体の様式のまま
  const newA = await call('/api/clients', CARE_A, { method: 'POST', body: JSON.stringify({ name: '新しい人' }) })
  const docA = (await call(`/api/clients/${newA.body.id}`, CARE_A)).body.client.documents.find((d: { kind: string }) => d.kind === 'assessment')
  assert.equal(docA.formVersionId, id)
  const newB = await call('/api/clients', 'Bearer dev:other@example.com', { method: 'POST', body: JSON.stringify({ name: 'ほかの人' }) })
  const docB = (await call(`/api/clients/${newB.body.id}`, 'Bearer dev:other@example.com')).body.client.documents.find((d: { kind: string }) => d.kind === 'assessment')
  assert.notEqual(docB.formVersionId, id)
  // 今の書類は、作ったときの版のまま
  assert.ok(Number((await db.query('SELECT count(*) AS n FROM documents WHERE template_version_id = $1', [existing])).rows[0].n) > 0)
  // 公開した版は、ケアマネの入口から読める。直す・捨てるのは 409
  assert.equal((await call(`/api/form-versions/${id}`, CARE_A)).status, 200)
  assert.equal((await patch('/api/office', id, ADMIN_A, { base: v.contentSha, localFields: [] })).body.error, 'not_draft')
  assert.equal((await call(`/api/office/form-versions/${id}`, ADMIN_A, { method: 'DELETE' })).status, 409)

  // 同じ様式の次の下書きを公開すると、前の版は退く
  const next = await makeDraft(ids.officeA, 'assessment')
  assert.equal((await publish('/api/office', next, ADMIN_A, (await get('/api/office', next, ADMIN_A)).body.formVersion.contentSha)).status, 200)
  assert.equal((await get('/api/office', id, ADMIN_A)).body.formVersion.status, 'retired')
})

test('全体の様式: 責任者は読むだけ（変えようとすると 403。下書きは見えない）。サイト管理者は直して公開できる', { skip }, async () => {
  const g = await get('/api/office', ids.globalAdmission, ADMIN_A)
  assert.deepEqual([g.status, g.body.formVersion.global], [200, true])
  assert.equal((await patch('/api/office', ids.globalAdmission, ADMIN_A, { base: g.body.formVersion.contentSha, localFields: [] })).status, 403)
  assert.equal((await publish('/api/office', ids.globalAdmission, ADMIN_A, g.body.formVersion.contentSha)).status, 403)
  assert.equal((await call(`/api/office/form-versions/${ids.globalAdmission}`, ADMIN_A, { method: 'DELETE' })).status, 403)

  await db.query("INSERT INTO form_kinds (key, name) VALUES ('sitetest', '試しの種類')")
  const draft = await makeDraft(null, 'sitetest')
  assert.equal((await get('/api/office', draft, ADMIN_A)).status, 404, '全体の様式の下書き（サイト管理者の作りかけ）は責任者に見えない')
  const v = (await get('/api/admin', draft, SITE)).body.formVersion
  assert.equal(v.global, true)
  const fixed = (await patch('/api/admin', draft, SITE, { base: v.contentSha, localFields: DRAFT.localFields })).body.formVersion
  assert.equal((await publish('/api/admin', draft, SITE, fixed.contentSha)).status, 200)
  assert.equal((await get('/api/office', draft, ADMIN_A)).status, 200, '公開したら責任者も読める')
})

test('下書きを捨てる: 取り込みの下書きの指しは空になる。ほかの事業所の下書きは 404', { skip }, async () => {
  const id = await makeDraft(ids.officeA, 'assessment')
  assert.equal((await call(`/api/office/form-versions/${id}`, ADMIN_B, { method: 'DELETE' })).status, 404)
  assert.equal((await call(`/api/office/form-versions/${id}`, ADMIN_A, { method: 'DELETE' })).status, 204)
  assert.equal((await get('/api/office', id, ADMIN_A)).status, 404)
  assert.equal((await db.query('SELECT count(*) AS n FROM form_imports WHERE version_id = $1', [id])).rows[0].n, '0')
})
