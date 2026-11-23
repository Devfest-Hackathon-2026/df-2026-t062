// 責任者の画面（#102）の入口: 書類ごとの書式の様子、欄に入る内容の言葉、言葉で欄を直す、使っていない欄、
// 使っている書式を直す下書き、最初の書式に戻す、前の事業所の書式に戻す。api・DB・置き場を通しで確かめる。
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
import { FIELD_LIST } from '../core/fields.ts'
import type { MatchInput, MatchResult } from '../core/slot-meaning.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_fadmin_${process.pid}`
const font = { BIZUDPGothic: { data: readFileSync(new URL('../forms/fonts/BIZUDPGothic-Regular.ttf', import.meta.url)), fallback: true, subset: true } }
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

let db: Db
let storage: Storage
let origin = ''
let close = async () => {}
const ids = { officeA: '', officeB: '', globalAssessment: '' }
const CARE_A = 'Bearer dev:kato@example.com'
const ADMIN_A = 'Bearer dev:admin-a@example.com'
const ADMIN_B = 'Bearer dev:admin-b@example.com'

/** 当てはめ（偽物）。呼ばれた言葉を覚え、決めた答えを返す */
const matcher = { calls: [] as MatchInput[], answer: null as MatchResult }

const call = async (path: string, token: string, init: RequestInit = {}) => {
  const res = await fetch(`${origin}${path}`, { ...init, headers: { Authorization: token, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, body: (type.includes('json') ? await res.json() : null) as any }
}
const post = (path: string, token: string, b: object = {}) => call(path, token, { method: 'POST', body: JSON.stringify(b) })

const name = FIELD_LIST.find((f) => f.key === 'person.name')!
const slot = (n: string, y: number, type = 'text') => ({
  name: n, type, content: '', position: { x: 61, y }, width: 38, height: 8,
  fontName: 'BIZUDPGothic', fontSize: 10, alignment: 'left', verticalAlignment: 'middle', lineHeight: 1, characterSpacing: 0, fontColor: '#1a3fa0',
})
const DRAFT = {
  schemas: [[slot('p1_氏名', 31), slot('p1_開催場所', 51), slot('p1_余白', 71)]],
  bindings: {
    p1_氏名: { op: 'text@1', ui: 'text', ref: { key: 'person.name' } },
    p1_開催場所: { op: 'text@1', ui: 'text', ref: { key: 'local.meetingPlace' } },
    p1_余白: { op: 'text@1', ui: 'text', ref: { key: 'person.name' } },
  },
  pages: [{ no: 1, pdfIndex: 0, title: '1 ページ', width: 210, height: 297 }],
  localFields: [{ key: 'local.meetingPlace', label: '開催場所', type: 'text' }],
  review: [{ slot: 'p1_開催場所', reason: '自信がない' }],
}

let pdfCount = 0
async function formPdf(): Promise<Uint8Array> {
  pdfCount++
  const t = { name: 'label', type: 'text', position: { x: 20, y: 32 }, width: 40, height: 8, fontName: 'BIZUDPGothic', fontSize: 12, alignment: 'left', verticalAlignment: 'top', lineHeight: 1, characterSpacing: 0, fontColor: '#000000', content: '' }
  const r = { name: 'box', type: 'rectangle', position: { x: 60, y: 30 }, width: 40, height: 10, borderWidth: 0.3, borderColor: '#000000', color: '', readOnly: true, content: '' }
  return new Uint8Array(await generate({ template: { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[r, t]] } as never, inputs: [{ label: `氏名 ${pdfCount}` }], plugins: { text, rectangle }, options: { font } }))
}

/** 取り込みのジョブが作るのと同じ下書きの版（取り込みつき） */
async function makeDraft(officeId: string | null, kind: string, draft: object = DRAFT): Promise<{ id: string, importId: string }> {
  const imports = await import('../db/form-imports.ts')
  const { basePdfAssetPath } = await import('../core/form.ts')
  const pdf = await formPdf()
  await storage.write('forms', basePdfAssetPath(sha(pdf), officeId), pdf, 'application/pdf')
  const imp = await imports.createImport(db, { officeId }, kind, null)
  await db.query('UPDATE form_imports SET uploaded_at = now() WHERE id = $1', [imp.id])
  const claimed = (await imports.claimImport(db, imp.id, 'test'))!
  return { id: (await imports.finishWithDraft(db, claimed, 'test', sha(pdf), draft as never))!, importId: imp.id }
}

const version = async (id: string) => (await call(`/api/office/form-versions/${id}`, ADMIN_A)).body
const publish = async (id: string) => post(`/api/office/form-versions/${id}/publish`, ADMIN_A, { base: (await version(id)).formVersion.contentSha })
const overview = async (token = ADMIN_A) => (await call('/api/office/forms', token)).body
const kindOf = (o: any, key: string) => o.kinds.find((k: { key: string }) => k.key === key)
const newDocVersion = async () => {
  const c = await post('/api/clients', CARE_A, { name: `新しい人 ${Math.random()}` })
  return (await call(`/api/clients/${c.body.id}`, CARE_A)).body.client.documents.find((d: { kind: string }) => d.kind === 'assessment').formVersionId
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
  ids.officeA = (await seed(db)).officeId
  ids.officeB = (await seed(db, { email: 'other@example.com', officeName: 'ほかの事業所' })).officeId
  for (const [office, email] of [[ids.officeA, 'admin-a@example.com'], [ids.officeB, 'admin-b@example.com']]) {
    await db.query("INSERT INTO staff (office_id, auth_uid, name, email, role) VALUES ($1, $2, '責任者', $3, 'admin')", [office, `dev:${email}`, email])
  }
  const forms = await import('../db/forms.ts')
  ids.globalAssessment = await forms.publishedVersionId(db, ids.officeA, 'assessment')

  process.env.PUBLIC_API_ORIGIN = ''
  const { LocalStorage } = await import('../api/storage.ts')
  storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-fadmin-')))
  const { createApiServer } = await import('../api/server.ts')
  const { DevVerifier } = await import('../api/auth.ts')
  const server = createApiServer({
    db: async () => db, verifier: () => new DevVerifier(), storage: () => storage,
    queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }), devAuth: true,
    fieldMatcher: async () => async (input) => { matcher.calls.push(input); return matcher.answer },
  })
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

test('書類ごとの書式の様子: はじめは全体の書式。取り込みと下書き（迷った欄つき）が出る。ケアマネは 403、ほかの事業所には出ない', { skip }, async () => {
  let a = kindOf(await overview(), 'assessment')
  assert.equal(a.name, 'アセスメント')
  assert.deepEqual([a.current.versionId, a.current.office], [ids.globalAssessment, false])
  assert.equal(a.draft, null)
  assert.equal(a.shelved, null)
  assert.equal((await call('/api/office/forms', CARE_A)).status, 403)

  const d = await makeDraft(ids.officeA, 'assessment')
  a = kindOf(await overview(), 'assessment')
  assert.equal(a.import.id, d.importId)
  assert.equal(a.import.status, 'succeeded')
  assert.equal(a.draft.versionId, d.id)
  assert.deepEqual(a.draft.review, DRAFT.review)
  assert.equal(a.draft.fromImport, true)
  assert.equal(a.draft.empty, false)
  assert.equal(a.import.uploaded, true)
  assert.equal(kindOf(await overview(ADMIN_B), 'assessment').draft, null, 'ほかの事業所の下書きは出ない')
  await call(`/api/office/form-versions/${d.id}`, ADMIN_A, { method: 'DELETE' })
})

test('版に、印字欄ごとの入る内容の言葉と、録音から書くかが付く。迷った欄も付く', { skip }, async () => {
  const d = await makeDraft(ids.officeA, 'assessment')
  const v = await version(d.id)
  assert.equal(v.slots.p1_氏名.what, name.label)
  assert.equal(v.slots.p1_氏名.rec, true, '氏名は会話から書ける欄')
  assert.deepEqual(v.slots.p1_開催場所, { what: '開催場所', rec: true }, '説明書きのない、その様式だけの欄も録音から書く（#152）')
  assert.deepEqual(v.review, DRAFT.review)
  await call(`/api/office/form-versions/${d.id}`, ADMIN_A, { method: 'DELETE' })
})

test('言葉で欄を直す: fields.json の欄に当たればその欄につなぐ。当たらなければ、その様式だけの欄を作る。前の欄が使われなくなれば消す', { skip }, async () => {
  const d = await makeDraft(ids.officeA, 'assessment')
  let base = (await version(d.id)).formVersion.contentSha
  const birth = FIELD_LIST.find((f) => f.key === 'person.birthDate') ?? FIELD_LIST.find((f) => f.type === 'date')!
  matcher.answer = { id: birth.key }
  let r = await post(`/api/office/form-versions/${d.id}/slots/p1_開催場所`, ADMIN_A, { base, text: '生年月日' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(matcher.calls.at(-1)!.text, '生年月日')
  assert.equal(matcher.calls.at(-1)!.mark, false)
  assert.equal(r.body.matched, 'field')
  assert.deepEqual(r.body.formVersion.bindings.p1_開催場所, { op: 'text@1', ui: 'text', ref: { key: birth.key } })
  assert.deepEqual(r.body.formVersion.localFields, [], '使われなくなった、その様式だけの欄は消す')
  assert.equal(r.body.slots.p1_開催場所.what, birth.label)
  assert.deepEqual(r.body.problems, [])

  base = r.body.formVersion.contentSha
  matcher.answer = null
  r = await post(`/api/office/form-versions/${d.id}/slots/p1_開催場所`, ADMIN_A, { base, text: 'ペットの名前' })
  assert.equal(r.body.matched, 'local')
  assert.deepEqual(r.body.formVersion.localFields, [{ key: 'local.custom_1', label: 'ペットの名前', type: 'text', note: 'ペットの名前' }])
  assert.deepEqual(r.body.formVersion.bindings.p1_開催場所.ref, { key: 'local.custom_1' })
  assert.deepEqual(r.body.slots.p1_開催場所, { what: 'ペットの名前', rec: true })

  // 当てはめが欄の形に合わない（文字の欄に画像の欄など）ときも、その様式だけの欄にする
  base = r.body.formVersion.contentSha
  matcher.answer = { id: 'ない.key' }
  r = await post(`/api/office/form-versions/${d.id}/slots/p1_開催場所`, ADMIN_A, { base, text: '飼い主' })
  assert.equal(r.body.matched, 'local')
  assert.deepEqual(r.body.formVersion.localFields.map((f: { key: string }) => f.key), ['local.custom_1'], '前の local.custom_1 は使われなくなったので消え、同じ名前で作り直す')
  assert.equal(r.body.formVersion.localFields[0].label, '飼い主')

  // 古い指紋なら 409、空の言葉なら 400、ない印字欄なら 404
  assert.equal((await post(`/api/office/form-versions/${d.id}/slots/p1_開催場所`, ADMIN_A, { base, text: 'x' })).status, 409)
  base = r.body.formVersion.contentSha
  assert.equal((await post(`/api/office/form-versions/${d.id}/slots/p1_開催場所`, ADMIN_A, { base, text: '  ' })).status, 400)
  assert.equal((await post(`/api/office/form-versions/${d.id}/slots/ないもの`, ADMIN_A, { base, text: 'x' })).status, 404)
  assert.equal((await post(`/api/office/form-versions/${d.id}/slots/p1_開催場所`, ADMIN_B, { base, text: 'x' })).status, 404)
  assert.equal((await post(`/api/office/form-versions/${d.id}/slots/p1_開催場所`, CARE_A, { base, text: 'x' })).status, 403)
  await call(`/api/office/form-versions/${d.id}`, ADMIN_A, { method: 'DELETE' })
})

test('使っていない欄: 印字欄と対応を消す（何も印刷しない）。公開した版や全体の書式は直せない', { skip }, async () => {
  const d = await makeDraft(ids.officeA, 'assessment')
  const base = (await version(d.id)).formVersion.contentSha
  const r = await post(`/api/office/form-versions/${d.id}/slots/p1_余白`, ADMIN_A, { base, unused: true })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.formVersion.schemas[0].map((s: { name: string }) => s.name), ['p1_氏名', 'p1_開催場所'])
  assert.equal(r.body.formVersion.bindings.p1_余白, undefined)
  assert.deepEqual(r.body.problems, [])
  const g = (await version(ids.globalAssessment)).formVersion
  const anySlot = g.schemas.flat()[0].name
  assert.equal((await post(`/api/office/form-versions/${ids.globalAssessment}/slots/${encodeURIComponent(anySlot)}`, ADMIN_A, { base: g.contentSha, unused: true })).status, 403)
  await call(`/api/office/form-versions/${d.id}`, ADMIN_A, { method: 'DELETE' })
})

test('使っている書式を直す: 今の版から下書きを作る（中身は同じ、番号は次）。下書きがあればそれを返す。全体の書式からは作れない', { skip }, async () => {
  const d = await makeDraft(ids.officeA, 'assessment')
  const pub = await publish(d.id)
  assert.equal(pub.status, 200, JSON.stringify(pub.body))
  assert.equal(pub.body.formVersion.status, 'published')
  const r = await post(`/api/office/form-versions/${d.id}/draft`, ADMIN_A)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const draft = r.body.formVersion
  assert.equal(draft.status, 'draft')
  assert.notEqual(draft.id, d.id)
  assert.deepEqual(draft.bindings, (await version(d.id)).formVersion.bindings)
  assert.equal(kindOf(await overview(), 'assessment').draft.versionId, draft.id)
  assert.deepEqual(kindOf(await overview(), 'assessment').draft.review, [], '直す下書きには迷った欄がない')
  assert.equal(kindOf(await overview(), 'assessment').draft.fromImport, false)
  const again = await post(`/api/office/form-versions/${d.id}/draft`, ADMIN_A)
  assert.deepEqual([again.status, again.body.formVersion.id], [200, draft.id])
  // 上げた PDF の下書き（別の書式）があっても、直す下書きはそれと別
  await call(`/api/office/form-versions/${draft.id}`, ADMIN_A, { method: 'DELETE' })
  const uploaded = await makeDraft(ids.officeA, 'assessment')
  const fixing = await post(`/api/office/form-versions/${d.id}/draft`, ADMIN_A)
  assert.equal(fixing.status, 201)
  assert.notEqual(fixing.body.formVersion.id, uploaded.id)
  await call(`/api/office/form-versions/${uploaded.id}`, ADMIN_A, { method: 'DELETE' })
  await call(`/api/office/form-versions/${fixing.body.formVersion.id}`, ADMIN_A, { method: 'DELETE' })
  assert.equal((await post(`/api/office/form-versions/${ids.globalAssessment}/draft`, ADMIN_A)).status, 403)
  assert.equal((await post(`/api/office/form-versions/${d.id}/draft`, ADMIN_B)).status, 404)
})

test('最初の書式に戻す・前の事業所の書式に戻す: 新しい書類の書式が替わる。今の書類は前の版のまま。記録が残る', { skip }, async () => {
  const d = await makeDraft(ids.officeA, 'assessment')
  await publish(d.id)
  const inUse = kindOf(await overview(), 'assessment').current
  assert.equal(inUse.office, true)
  assert.equal(await newDocVersion(), inUse.versionId)

  // 最初の書式に戻す
  const r = await post('/api/office/forms/assessment/revert', ADMIN_A)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  let a = kindOf(await overview(), 'assessment')
  assert.deepEqual([a.current.versionId, a.current.office], [ids.globalAssessment, false])
  assert.equal(a.shelved.versionId, inUse.versionId)
  assert.equal(await newDocVersion(), ids.globalAssessment)
  assert.ok(Number((await db.query('SELECT count(*) AS n FROM documents WHERE template_version_id = $1', [inUse.versionId])).rows[0].n) > 0, '前に作った書類は前の版のまま')
  assert.equal((await post('/api/office/forms/assessment/revert', ADMIN_A)).status, 200, 'もう戻っていても 200')
  assert.equal((await post('/api/office/forms/assessment/revert', CARE_A)).status, 403)
  assert.equal((await post('/api/office/forms/ないもの/revert', ADMIN_A)).status, 404)

  // 前の事業所の書式に戻す（退いた版は公開し直せないので、同じ中身の版を作って公開する）
  const back = await post(`/api/office/form-versions/${a.shelved.versionId}/reuse`, ADMIN_A)
  assert.equal(back.status, 200, JSON.stringify(back.body))
  assert.equal(back.body.formVersion.status, 'published')
  a = kindOf(await overview(), 'assessment')
  assert.deepEqual([a.current.versionId, a.current.office], [back.body.formVersion.id, true])
  assert.equal(a.shelved, null)
  assert.equal(await newDocVersion(), back.body.formVersion.id)
  assert.equal((await post(`/api/office/form-versions/${back.body.formVersion.id}/reuse`, ADMIN_A)).status, 409, '使っている版は戻せない')
  assert.equal((await post(`/api/office/form-versions/${ids.globalAssessment}/reuse`, ADMIN_A)).status, 403)

  const actions = (await db.query("SELECT action FROM audit_events WHERE office_id = $1 AND action LIKE 'form.%' ORDER BY occurred_at", [ids.officeA])).rows.map((x) => x.action)
  assert.deepEqual(actions.filter((x) => x === 'form.revert' || x === 'form.reuse'), ['form.revert', 'form.reuse'])
  // あと片づけ: 最初の書式に戻す（ほかのテストのため）
  await post('/api/office/forms/assessment/revert', ADMIN_A)
})

test('書く欄が 1 つもない書式は使い始められない（読み取りで欄を見つけられなかった）', { skip }, async () => {
  const d = await makeDraft(ids.officeA, 'assessment', { ...DRAFT, schemas: [[]], bindings: {}, localFields: [], review: [] })
  assert.equal(kindOf(await overview(), 'assessment').draft.empty, true)
  const r = await publish(d.id)
  assert.equal(r.status, 422)
  assert.deepEqual(r.body.problems, ['印字欄がない'])
  await call(`/api/office/form-versions/${d.id}`, ADMIN_A, { method: 'DELETE' })
})
