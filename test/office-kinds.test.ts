// 事業所の責任者が書類の種類を足す（#153）。足した種類はその事業所だけに出て、書式を使い始めるまでは作れない。
// やめた種類は新しく作れないが、今ある書類は開ける。録音から書く種類は、書式を使い始めるときに AI が項目を決める（#209）。api・DB を通しで確かめる。
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
import type { TopicDraftInput } from '../core/topics.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_okinds_${process.pid}`
let db: Db
let storage: Storage
let origin = ''
let close = async () => {}
const ids = { officeA: '', officeB: '' }
const CARE_A = 'Bearer dev:kato@example.com'
const CARE_B = 'Bearer dev:other@example.com'
const ADMIN_A = 'Bearer dev:admin-a@example.com'
const ADMIN_B = 'Bearer dev:admin-b@example.com'
/** 拾う内容の案を作る AI（偽物）。渡された欄の言葉を覚え、決めた案を返す。fail なら失敗する */
const drafter = { calls: [] as TopicDraftInput[], fail: false }

const call = async (path: string, token: string, init: RequestInit = {}) => {
  const res = await fetch(`${origin}${path}`, { ...init, headers: { Authorization: token, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, body: (type.includes('json') ? await res.json() : null) as any }
}
const post = (path: string, token: string, b: object = {}) => call(path, token, { method: 'POST', body: JSON.stringify(b) })
const put = (path: string, token: string, b: object = {}) => call(path, token, { method: 'PUT', body: JSON.stringify(b) })

/** 足した種類に、事業所の書式を公開する（取り込みの代わりに、版を直接入れる） */
async function publishOfficeForm(officeId: string, kind: string) {
  const { registerVersion } = await import('../db/forms.ts')
  const slot = (name: string, y: number) => ({ name, type: 'text' as const, position: { x: 20, y }, width: 60, height: 8 })
  return registerVersion(db, {
    kind, name: '訪問記録', title: '訪問記録', officeId, basePdfSha256: 'b'.repeat(64),
    schemas: [[slot('氏名', 20), slot('様子', 30)]],
    bindings: { 氏名: { op: 'text@1', ui: 'text', ref: { key: 'person.name' } }, 様子: { op: 'text@1', ui: 'area', ref: { key: 'local.visitMood' } } },
    pages: [{ no: 1, pdfIndex: 0, title: '1 ページ', width: 210, height: 297 }],
    localFields: [{ key: 'local.visitMood', label: '訪問時の様子', type: 'longtext' }],
  }, { publish: true })
}

const font = { BIZUDPGothic: { data: readFileSync(new URL('../forms/fonts/BIZUDPGothic-Regular.ttf', import.meta.url)), fallback: true, subset: true } }
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
let pdfCount = 0
/** 取り込みのジョブが作るのと同じ下書きの版を作り、元の PDF も様式の場所に置く（呼ぶたびに別の PDF）。欄は「氏名」と、その書式だけの「訪問時の様子」 */
async function draftOfficeForm(officeId: string, kind: string): Promise<string> {
  pdfCount++
  const label = { name: 'label', type: 'text', position: { x: 20, y: 32 }, width: 40, height: 8, fontName: 'BIZUDPGothic', fontSize: 12, alignment: 'left', verticalAlignment: 'top', lineHeight: 1, characterSpacing: 0, fontColor: '#000000', content: '' }
  const pdf = new Uint8Array(await generate({ template: { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[label]] } as never, inputs: [{ label: `訪問記録 ${pdfCount}` }], plugins: { text, rectangle }, options: { font } }))
  const { basePdfAssetPath } = await import('../core/form.ts')
  await storage.write('forms', basePdfAssetPath(sha(pdf), officeId), pdf, 'application/pdf')
  const slot = (name: string, y: number) => ({ name, type: 'text', content: '', position: { x: 61, y }, width: 38, height: 8, fontName: 'BIZUDPGothic', fontSize: 10, alignment: 'left', verticalAlignment: 'middle', lineHeight: 1, characterSpacing: 0, fontColor: '#1a3fa0' })
  const draft = {
    schemas: [[slot('p1_氏名', 31), slot('p1_様子', 51)]],
    bindings: { p1_氏名: { op: 'text@1', ui: 'text', ref: { key: 'person.name' } }, p1_様子: { op: 'text@1', ui: 'text', ref: { key: 'local.visitMood' } } },
    pages: [{ no: 1, pdfIndex: 0, title: '1 ページ', width: 210, height: 297 }],
    localFields: [{ key: 'local.visitMood', label: '訪問時の様子', type: 'text' }],
    review: [],
  }
  const imports = await import('../db/form-imports.ts')
  const imp = await imports.createImport(db, { officeId }, kind, null)
  await db.query('UPDATE form_imports SET uploaded_at = now() WHERE id = $1', [imp.id])
  const claimed = (await imports.claimImport(db, imp.id, 'test'))!
  return (await imports.finishWithDraft(db, claimed, 'test', sha(pdf), draft as never))!
}
/** 責任者が「使い始める」を押す（手順 3 の最後） */
async function startUsing(id: string, token = ADMIN_A) {
  const v = await call(`/api/office/form-versions/${id}`, token)
  return post(`/api/office/form-versions/${id}/publish`, token, { base: v.body.formVersion.contentSha })
}
const topicsOf = async (key: string) => (await db.query('SELECT topics FROM form_kinds WHERE key = $1', [key])).rows[0].topics as any[]

const newKind = async (token = ADMIN_A, body: object = {}) =>
  post('/api/office/form-kinds', token, { name: '訪問記録', perClient: 'many', append: false, ...body })
const kindsOf = async (token: string) => (await call('/api/form-kinds', token)).body.kinds as any[]
const newClient = async (token = CARE_A) => (await post('/api/clients', token, { name: `見本 ${Math.random()}` })).body.id as string

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
  const { LocalStorage } = await import('../api/storage.ts')
  storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-okinds-')))
  const { createApiServer } = await import('../api/server.ts')
  const { DevVerifier } = await import('../api/auth.ts')
  const server = createApiServer({
    db: async () => db, verifier: () => new DevVerifier(), storage: () => storage,
    queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }), devAuth: true,
    topicDrafter: async () => async (input) => {
      drafter.calls.push(input)
      if (drafter.fail) throw new Error('AI が答えなかった')
      return [{ name: '訪問時の様子', guide: '訪問したときの本人の様子と、話したこと' }]
    },
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

test('足した種類は、その事業所にだけ出る。書式を使い始めるまでは作れず、使い始めると作れる', { skip }, async () => {
  const r = await newKind()
  assert.equal(r.status, 201)
  const key = r.body.kind.key as string
  const mine = (await kindsOf(CARE_A)).find((k) => k.key === key)
  assert.deepEqual([mine.name, mine.perClient, mine.isPrimary, mine.createFrom, mine.available], ['訪問記録', 'many', false, 'assessment', false])
  assert.equal((await kindsOf(CARE_B)).some((k) => k.key === key), false, 'ほかの事業所のケアマネには出ない')
  assert.ok((await call('/api/office/forms', ADMIN_A)).body.kinds.some((k: any) => k.key === key))
  assert.equal((await call('/api/office/forms', ADMIN_B)).body.kinds.some((k: any) => k.key === key), false, 'ほかの事業所の責任者にも出ない')

  const client = await newClient()
  assert.notEqual((await post(`/api/clients/${client}/documents`, CARE_A, { kind: key })).status, 201, '書式を使い始めるまでは作れない')
  await publishOfficeForm(ids.officeA, key)
  assert.equal((await kindsOf(CARE_A)).find((k) => k.key === key).available, true)
  assert.equal((await post(`/api/clients/${client}/documents`, CARE_A, { kind: key })).status, 201)
})

test('ほかの事業所の種類は、作れない・書式を上げられない・拾う内容を直せない', { skip }, async () => {
  const key = (await newKind()).body.kind.key as string
  await publishOfficeForm(ids.officeA, key)
  const clientB = await newClient(CARE_B)
  assert.notEqual((await post(`/api/clients/${clientB}/documents`, CARE_B, { kind: key })).status, 201)
  assert.equal((await post('/api/office/form-imports', ADMIN_B, { kind: key })).status, 400)
  assert.equal((await put(`/api/office/form-kinds/${key}/topics`, ADMIN_B, { topics: [] })).status, 404)
  assert.equal((await post(`/api/office/form-kinds/${key}/retire`, ADMIN_B)).status, 404)
})

test('責任者でない職員は、種類を足せない', { skip }, async () => {
  assert.equal((await newKind(CARE_A)).status, 403)
})

test('足した種類は、いつもアセスメントを元にし、項目は全体のまとめから始まる。2 回目から前の録音も使うなら要約は足していく', { skip }, async () => {
  const single = (await newKind()).body.kind.key
  const append = (await newKind(ADMIN_A, { append: true, perClient: 'one' })).body.kind.key
  const rows = Object.fromEntries((await db.query('SELECT key, topics, summary_mode, per_client, create_from, required, is_primary FROM form_kinds WHERE key = ANY($1)', [[single, append]])).rows.map((r) => [r.key, r]))
  for (const k of [single, append]) {
    assert.equal(rows[k].create_from, 'assessment', 'どの種類でも「アセスメントから AI が書く」が出る')
    assert.deepEqual(rows[k].topics.map((t: any) => [t.name, t.last]), [['全体のまとめ', true]])
  }
  assert.deepEqual([rows[single].summary_mode, rows[append].summary_mode], ['single', 'append'])
  assert.deepEqual([rows[append].per_client, rows[append].required, rows[append].is_primary], ['one', [], false])
})

test('録音から書く種類は、書式を使い始めると、書式の欄から AI が作った項目がそのまま入る（全体のまとめは最後）', { skip }, async () => {
  const key = (await newKind()).body.kind.key as string
  const r = await startUsing(await draftOfficeForm(ids.officeA, key))
  assert.equal(r.status, 200)
  assert.equal(drafter.calls.at(-1)!.kindName, '訪問記録')
  assert.ok(drafter.calls.at(-1)!.slots.includes('訪問時の様子'), '書式の欄の言葉を渡す')
  const topics = await topicsOf(key)
  assert.deepEqual(topics.map((t) => [t.name, t.by, t.last]), [['訪問時の様子', 'ai', false], ['全体のまとめ', 'ai', true]])
})

test('項目がもうある種類は、直した書式を使い始めても項目を変えず、AI も呼ばない', { skip }, async () => {
  const key = (await newKind()).body.kind.key as string
  await startUsing(await draftOfficeForm(ids.officeA, key))
  const mine = [{ name: '次回までにすること', guide: '次の訪問までに本人・家族・ケアマネがすること' }]
  assert.equal((await put(`/api/office/form-kinds/${key}/topics`, ADMIN_A, { topics: mine })).status, 200)
  const before = drafter.calls.length
  assert.equal((await startUsing(await draftOfficeForm(ids.officeA, key))).status, 200)
  assert.equal(drafter.calls.length, before)
  assert.deepEqual((await topicsOf(key)).map((t) => t.name), ['次回までにすること', '全体のまとめ'])
})

test('AI が項目を作れなくても使い始められる。項目は全体のまとめだけ', { skip }, async () => {
  const key = (await newKind()).body.kind.key as string
  drafter.fail = true
  try {
    assert.equal((await startUsing(await draftOfficeForm(ids.officeA, key))).status, 200)
  } finally { drafter.fail = false }
  assert.equal((await kindsOf(CARE_A)).find((k) => k.key === key).available, true)
  assert.deepEqual((await topicsOf(key)).map((t) => t.name), ['全体のまとめ'])
})

test('全体の種類は、書式を使い始めても AI を呼ばず、これまでの要約の項目のまま', { skip }, async () => {
  const assessment = await topicsOf('assessment')
  const before = drafter.calls.length
  assert.equal((await startUsing(await draftOfficeForm(ids.officeA, 'assessment'))).status, 200)
  assert.equal(drafter.calls.length, before)
  assert.deepEqual(await topicsOf('assessment'), assessment)
})

test('拾う内容: 足した種類は、責任者が直せる。全体の種類は直せない', { skip }, async () => {
  const key = (await newKind()).body.kind.key as string
  const saved = await put(`/api/office/form-kinds/${key}/topics`, ADMIN_A, { topics: [{ name: '訪問時の様子', guide: '訪問したときの本人の様子' }, { name: '次回までにすること', guide: '次の訪問までに本人・家族・ケアマネがすること' }] })
  assert.equal(saved.status, 200)
  const topics = await topicsOf(key)
  assert.deepEqual(topics.filter((t) => !t.last).map((t) => t.name), ['訪問時の様子', '次回までにすること'])
  assert.equal(new Set(topics.map((t) => t.id)).size, topics.length, '項目の id は重ならない')
  assert.equal((await put('/api/office/form-kinds/assessment/topics', ADMIN_A, { topics: [] })).status, 403)
})

test('やめた種類は、新しく作れない。今ある書類は開ける。一覧には「やめた」と出る', { skip }, async () => {
  const key = (await newKind()).body.kind.key as string
  await publishOfficeForm(ids.officeA, key)
  const client = await newClient()
  const doc = (await post(`/api/clients/${client}/documents`, CARE_A, { kind: key })).body.id
  assert.equal((await post(`/api/office/form-kinds/${key}/retire`, ADMIN_A)).status, 200)
  const k = (await kindsOf(CARE_A)).find((x) => x.key === key)
  assert.deepEqual([k.available, k.retired], [false, true])
  assert.notEqual((await post(`/api/clients/${client}/documents`, CARE_A, { kind: key })).status, 201)
  assert.equal((await call(`/api/documents/${doc}`, CARE_A)).status, 200)
  assert.equal((await call('/api/office/forms', ADMIN_A)).body.kinds.some((x: any) => x.key === key), false, '責任者の一覧からは消える')
  assert.equal((await post('/api/office/form-kinds/assessment/retire', ADMIN_A)).status, 403, '全体の種類はやめられない')
})

test('使っている版より古い下書き（読めなかった取り込みの残り）は、責任者の一覧に出さない', { skip }, async () => {
  const key = (await newKind()).body.kind.key as string
  const imports = await import('../db/form-imports.ts')
  const imp = await imports.createImport(db, { officeId: ids.officeA }, key, null)
  await db.query('UPDATE form_imports SET uploaded_at = now() WHERE id = $1', [imp.id])
  const claimed = (await imports.claimImport(db, imp.id, 't'))!
  await imports.finishWithDraft(db, claimed, 't', 'c'.repeat(64), { schemas: [[]], bindings: {}, pages: [{ no: 1, pdfIndex: 0, title: '1 ページ', width: 210, height: 297 }], localFields: [], review: [] } as never)
  await publishOfficeForm(ids.officeA, key)
  const k = (await call('/api/office/forms', ADMIN_A)).body.kinds.find((x: any) => x.key === key)
  assert.ok(k.current, '使い始めている')
  assert.equal(k.draft, null)
})
