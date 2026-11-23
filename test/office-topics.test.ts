// 事業所が直せる項目（#115）: 責任者の API（AI 特訓部屋）と、書類の応答の「まだ聞いていない」。api・DB を通しで確かめる。AI は偽物。
// docs/再設計/17_録音からの書き込み.md の「事業所が直せる項目」。録音の処理が書き足しを使うことは test/summary-job.test.ts、
// 最後のチェックに説明を渡さないことは test/summary-writer.test.ts が確かめる。
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Db } from '../db/pool.ts'
import type { TeachDecision, TeachInput } from '../core/topics.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_otopics_${process.pid}`
let db: Db
let origin = ''
let close = async () => {}
const ids = { officeA: '', officeB: '' }
const CARE_A = 'Bearer dev:kato@example.com'
const ADMIN_A = 'Bearer dev:admin-a@example.com'
const ADMIN_B = 'Bearer dev:admin-b@example.com'
/** 振り分けの AI（偽物）。次に返す答えを決められる */
const teacher = { calls: [] as TeachInput[], next: null as TeachDecision | null }

const call = async (path: string, token: string, init: RequestInit = {}) => {
  const res = await fetch(`${origin}${path}`, { ...init, headers: { Authorization: token, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, body: (type.includes('json') ? await res.json() : null) as any }
}
const post = (path: string, token: string, b: object = {}) => call(path, token, { method: 'POST', body: JSON.stringify(b) })
const put = (path: string, token: string, b: object = {}) => call(path, token, { method: 'PUT', body: JSON.stringify(b) })
const edit = (b: Partial<{ added: object[], notes: Record<string, string[]>, passed: string[] }>) => ({ added: [], notes: {}, passed: [], ...b })
const officeRow = async (office: string) => (await db.query("SELECT added, notes, passed FROM office_topics WHERE office_id = $1 AND kind = 'assessment'", [office])).rows[0]

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
  const storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-otopics-')))
  const { createApiServer } = await import('../api/server.ts')
  const { DevVerifier } = await import('../api/auth.ts')
  const { fakeTopicTeacher } = await import('../core/topics.ts')
  const server = createApiServer({
    db: async () => db, verifier: () => new DevVerifier(), storage: () => storage,
    queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }), devAuth: true,
    topicTeacher: async () => async (input) => {
      teacher.calls.push(input)
      const d = teacher.next
      teacher.next = null
      return d ?? fakeTopicTeacher(input)
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

test('特訓の項目: アセスメントは基本情報 9・課題分析 14 の 23 項目。全体のまとめと日付は出ない', { skip }, async () => {
  const r = await call('/api/office/topics/assessment', ADMIN_A)
  assert.equal(r.status, 200)
  const items = r.body.items as any[]
  assert.deepEqual([items.filter((i) => i.section === '基本情報').length, items.filter((i) => i.section === '課題分析').length, items.length], [9, 14, 23])
  assert.ok(items.every((i) => i.origin === 'standard' && !i.removable))
})

test('直す: 書き足しと足した項目と合格の印が残り、ほかの事業所の一覧は変わらない。直したことを記録に残す（中身は残さない）', { skip }, async () => {
  const r = await put('/api/office/topics/assessment', ADMIN_A, edit({
    added: [{ name: 'ペット', guide: 'ペットの有無と、世話をしている人' }],
    notes: { eating: ['水分の量は、数字のまま書く'] },
    passed: ['basic', 'history'],
  }))
  assert.equal(r.status, 200)
  const pet = r.body.items.find((i: any) => i.name === 'ペット')
  assert.deepEqual([pet.origin, pet.removable], ['added', true])
  assert.deepEqual(r.body.items.find((i: any) => i.id === 'eating').notes, ['水分の量は、数字のまま書く'])
  assert.deepEqual((await call('/api/office/topics/assessment', ADMIN_A)).body.items.filter((i: any) => i.passed).map((i: any) => i.id), ['basic', 'history'], '開き直しても合格の印が残る')
  assert.equal(await officeRow(ids.officeB), undefined, 'ほかの事業所の一覧は変わらない')
  assert.equal((await call('/api/office/topics/assessment', ADMIN_B)).body.items.some((i: any) => i.notes.length || i.passed), false)
  const audit = (await db.query("SELECT detail FROM audit_events WHERE action = 'office_topics.update' AND office_id = $1 ORDER BY id DESC LIMIT 1", [ids.officeA])).rows[0]
  assert.deepEqual(audit.detail, { kind: 'assessment', added: 1, noteLines: 1, passed: 2 })
})

test('取り消す: 書き足しを消すと、録音の処理が読む行からも消える', { skip }, async () => {
  await put('/api/office/topics/assessment', ADMIN_A, edit({ notes: { health: ['薬の飲み忘れも書く', '血圧の数字も書く'] } }))
  await put('/api/office/topics/assessment', ADMIN_A, edit({ notes: { health: ['血圧の数字も書く'] } }))
  assert.deepEqual((await officeRow(ids.officeA)).notes, { health: '血圧の数字も書く' })
})

test('直せないもの: 一覧にない項目・日付への書き足し、全体の項目と同じ id の足しは 400。ケアマネは 403。ほかの事業所の種類は 404', { skip }, async () => {
  assert.equal((await put('/api/office/topics/assessment', ADMIN_A, edit({ notes: { ghost: ['書いて'] } }))).status, 400)
  assert.equal((await put('/api/office/topics/assessment', ADMIN_A, edit({ notes: { date: ['書いて'] } }))).status, 400)
  assert.equal((await put('/api/office/topics/assessment', ADMIN_A, edit({ added: [{ id: 'health', name: '体のこと', guide: '' }] }))).status, 400)
  assert.equal((await put('/api/office/topics/assessment', CARE_A, edit({}))).status, 403)
  assert.equal((await call('/api/office/topics/assessment', CARE_A)).status, 403)
  const key = (await post('/api/office/form-kinds', ADMIN_A, { name: '訪問記録', perClient: 'many', copyFromPrimary: false, records: true, append: false })).body.kind.key
  assert.equal((await call(`/api/office/topics/${key}`, ADMIN_B)).status, 404)
  assert.equal((await put(`/api/office/topics/${key}`, ADMIN_B, edit({}))).status, 404)
})

test('振り分け: AI に項目の一覧（書き足しを含む）と今見ている項目を渡し、答えを確かめて返す。保存はしない', { skip }, async () => {
  await put('/api/office/topics/assessment', ADMIN_A, edit({ notes: { eating: ['水分の量は数字で'] } }))
  teacher.next = { type: 'note', topicId: 'ghost', line: '金魚の世話' }
  const r = await post('/api/office/topics/assessment/teach', ADMIN_A, { text: '金魚の世話も書いて', current: null })
  assert.equal(r.status, 200)
  assert.equal(r.body.decision.type, 'new', 'AI が一覧にない項目を指したら、新しい項目にする')
  const sent = teacher.calls.at(-1)!
  assert.equal(sent.items.length, 23)
  assert.match(sent.items.find((i) => i.id === 'eating')!.guide, /水分の量は数字で/)
  assert.deepEqual((await officeRow(ids.officeA)).notes, { eating: '水分の量は数字で' }, '振り分けだけでは保存しない')
  assert.equal((await post('/api/office/topics/assessment/teach', CARE_A, { text: 'x', current: null })).status, 403)
})

test('書類の応答: 足していく書類で、足した項目の要約がまだなければ、id と名前だけを出す。要約ができたら出ない', { skip }, async () => {
  await put('/api/office/topics/assessment', ADMIN_A, edit({ added: [{ id: 'o1', name: 'ペット', guide: 'ペットの有無' }] }))
  const client = (await post('/api/clients', CARE_A, { name: '見本 花子' })).body.id as string
  const doc = (await db.query("SELECT id FROM documents WHERE client_id = $1 AND kind = 'assessment'", [client])).rows[0].id as string
  assert.deepEqual((await call(`/api/documents/${doc}`, CARE_A)).body.unheardTopics, [{ id: 'o1', name: 'ペット' }])
  const staff = (await db.query("SELECT id FROM staff WHERE email = 'kato@example.com' AND office_id = $1", [ids.officeA])).rows[0].id
  const rec = (await db.query(
    `INSERT INTO recordings (office_id, client_id, document_id, object_path, mime, status, recorded_at, created_by)
     VALUES ($1,$2,$3,'recordings/x.webm','audio/webm','uploaded','2026-11-20T00:00:00Z',$4) RETURNING id`, [ids.officeA, client, doc, staff],
  )).rows[0].id
  await db.query("INSERT INTO recording_summaries (office_id, client_id, recording_id, document_id, topic, text) VALUES ($1,$2,$3,$4,'o1','犬を飼っている')", [ids.officeA, client, rec, doc])
  const after = (await call(`/api/documents/${doc}`, CARE_A)).body
  assert.deepEqual(after.unheardTopics, [])
  assert.equal(JSON.stringify(after).includes('犬を飼っている'), false, '要約の中身は出さない')
})
