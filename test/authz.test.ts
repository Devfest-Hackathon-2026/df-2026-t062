// 役割ごとの権限（#109、docs/再設計/14_認可.md）。権限表・入口の宣言は DB なし、入口での確かめは api と DB を通しで確かめる。
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createApp, routeDeclarations, type ApiDeps } from '../api/app.ts'
import { FirebaseAccounts } from '../api/auth.ts'
import { allows, OPERATIONS, operationsOf, type Operation } from '../api/permissions.ts'

const unused = () => { throw new Error('使わない') }
const offlineDeps: ApiDeps = { db: unused, verifier: unused, storage: unused, queue: unused }

test('権限表: 14_認可.md の表のとおり', () => {
  const table: Record<Operation, [boolean, boolean, boolean]> = {
    'care.work': [true, true, false],
    'staff.manage': [false, true, false],
    'form.manage': [false, true, false],
    'site.manage': [false, false, true],
    'recording.retention.manage': [false, true, false],
  }
  assert.deepEqual([...OPERATIONS].sort(), Object.keys(table).sort())
  for (const op of OPERATIONS) assert.deepEqual(['caremanager', 'admin', 'siteAdmin'].map((r) => allows(r, op)), table[op], op)
  assert.deepEqual(operationsOf('admin'), ['care.work', 'staff.manage', 'form.manage', 'recording.retention.manage'])
  assert.deepEqual(operationsOf('知らない役割'), [], '表にない役割は何もできない')
})

test('入口はどれも、操作を 1 つ宣言している（宣言のない入口はここで落ちる）', () => {
  const routes = routeDeclarations(createApp(offlineDeps))
  assert.ok(routes.length > 10)
  assert.deepEqual(routes.filter((r) => r.declared === undefined).map((r) => `${r.method} ${r.path}`), [])
  // ログインなしの入口は、health と、署名で確かめる開発用の置き場の入口だけ
  assert.deepEqual(routes.filter((r) => r.declared === 'public').map((r) => r.path).sort(), ['/api/dev-files/forms/*', '/api/dev-upload/:token', '/api/health.json'])
  // 責任者の入口は /api/office/、サイト管理者の入口は /api/admin/ に置く
  for (const r of routes) {
    if (r.declared === 'site.manage') assert.match(r.path, /^\/api\/admin\//, r.path)
    else assert.doesNotMatch(r.path, /^\/api\/admin\//, r.path)
    if (r.declared === 'staff.manage' || r.declared === 'form.manage') assert.match(r.path, /^\/api\/office\//, r.path)
  }
})

test('宣言のない入口を足すと、見つかる', () => {
  const app = createApp(offlineDeps)
  app.get('/api/forgotten', (c) => c.text('x'))
  assert.deepEqual(routeDeclarations(app).filter((r) => r.declared === undefined).map((r) => r.path), ['/api/forgotten'])
})

test('アカウントを作る（firebase-admin）: あればその uid、なければ作る。同時に作られたら、作られたほうを使う', async () => {
  const made: { email: string, displayName: string }[] = []
  const users = new Map([['old@example.com', 'uid-old']])
  const notFound = () => Object.assign(new Error('no user'), { code: 'auth/user-not-found' })
  const admin = {
    async getUserByEmail(email: string) { const uid = users.get(email); if (!uid) throw notFound(); return { uid } },
    async createUser(p: { email: string, displayName: string }) { made.push(p); users.set(p.email, 'uid-new'); return { uid: 'uid-new' } },
  }
  const accounts = new FirebaseAccounts(async () => admin)
  assert.deepEqual(await accounts.ensureUser('old@example.com', '前から'), { uid: 'uid-old', created: false })
  assert.deepEqual(await accounts.ensureUser('new@example.com', '新しい人'), { uid: 'uid-new', created: true })
  assert.deepEqual(made, [{ email: 'new@example.com', displayName: '新しい人' }])
  // 調べたあと、作る前に別のリクエストが作った
  const racing = new FirebaseAccounts(async () => ({
    getUserByEmail: async (email: string) => { if (!made.some((m) => m.email === email)) { made.push({ email, displayName: '' }); throw notFound() } return { uid: 'uid-race' } },
    createUser: async () => { throw Object.assign(new Error('exists'), { code: 'auth/email-already-exists' }) },
  }))
  assert.deepEqual(await racing.ensureUser('race@example.com', '同時'), { uid: 'uid-race', created: false })
  // それ以外の誤りはそのまま
  const broken = new FirebaseAccounts(async () => ({ getUserByEmail: async () => { throw Object.assign(new Error('x'), { code: 'auth/internal-error' }) }, createUser: async () => ({ uid: '' }) }))
  await assert.rejects(broken.ensureUser('x@example.com', 'x'))
})

// ---------- ここから DB を使う ----------

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_authz_${process.pid}`
let origin = ''
let close = async () => {}
let routes: ReturnType<typeof routeDeclarations> = []
const ids = { officeA: '', officeB: '', clientA: '', careA: '', adminA: '', disabledA: '', careB: '', adminB: '' }

/** 使う人（dev のトークン） */
const WHO = {
  care: 'dev:kato@example.com', // 事業所 A のケアマネ
  admin: 'dev:admin-a@example.com', // 事業所 A の責任者
  disabled: 'dev:stopped-a@example.com', // 事業所 A の止めた職員（責任者）
  site: 'dev:site@example.com', // サイト管理者
  anon: '',
  careB: 'dev:other@example.com', // 事業所 B のケアマネ
  adminB: 'dev:admin-b@example.com', // 事業所 B の責任者
} as const

const call = async (path: string, token: string, init: RequestInit = {}) => {
  const res = await fetch(`${origin}${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, body: type.includes('json') ? await res.json() : null }
}

before(async () => {
  if (!url) return
  const { createPool } = await import('../db/pool.ts')
  const root = await createPool({ DATABASE_URL: url })
  await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  await root.end()
  const db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema })
  const { migrate } = await import('../db/migrate.ts')
  await migrate(db)
  const { seed } = await import('../db/seed.ts')
  const a = await seed(db)
  const b = await seed(db, { email: 'other@example.com', officeName: 'ほかの事業所' })
  const staff = async (officeId: string, email: string, role: string, disabled = false) => (await db.query(
    `INSERT INTO staff (office_id, auth_uid, name, email, role, disabled_at) VALUES ($1, $2, $3, $4, $5, ${disabled ? 'now()' : 'NULL'}) RETURNING id`,
    [officeId, `dev:${email}`, email.split('@')[0], email, role],
  )).rows[0].id as string
  Object.assign(ids, {
    officeA: a.officeId, officeB: b.officeId, clientA: a.clients.kai, careA: a.staff.id, careB: b.staff.id,
    adminA: await staff(a.officeId, 'admin-a@example.com', 'admin'),
    disabledA: await staff(a.officeId, 'stopped-a@example.com', 'admin', true),
    adminB: await staff(b.officeId, 'admin-b@example.com', 'admin'),
  })
  await db.query("INSERT INTO site_admins (auth_uid, name, email) VALUES ('dev:site@example.com', 'サイト管理者', 'site@example.com')")

  const { createApiServer } = await import('../api/server.ts')
  const { DevVerifier } = await import('../api/auth.ts')
  const { LocalStorage } = await import('../api/storage.ts')
  const storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-authz-')))
  const { DevAccounts } = await import('../api/auth.ts')
  const deps: ApiDeps = { db: async () => db, verifier: () => new DevVerifier(), storage: () => storage, queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }), devAuth: true, accounts: () => new DevAccounts() }
  routes = routeDeclarations(createApp(deps))
  const server = createApiServer(deps)
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

/** 入口の道に、どこにもない ID を入れる（中身まで進んでも 404 か 400 で止まる） */
const fill = (path: string) => path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000').replace('*', 'x')

test('すべての入口で、宣言した操作について、使う人ごとに通す・断るが 14_認可.md の表のとおり', { skip }, async () => {
  // 通すときは、中身の確かめ（ID がない・入力の形が違う）まで進む。ここでは 401・403 にならず、500 にもならないことを見る
  const PASS = 'pass'
  const expect: Record<Operation, Record<keyof typeof WHO, number | typeof PASS>> = {
    'care.work': { care: PASS, admin: PASS, disabled: 401, site: 401, anon: 401, careB: PASS, adminB: PASS },
    'staff.manage': { care: 403, admin: PASS, disabled: 401, site: 401, anon: 401, careB: 403, adminB: PASS },
    'form.manage': { care: 403, admin: PASS, disabled: 401, site: 401, anon: 401, careB: 403, adminB: PASS },
    'site.manage': { care: 403, admin: 403, disabled: 403, site: PASS, anon: 401, careB: 403, adminB: 403 },
    'recording.retention.manage': { care: 403, admin: PASS, disabled: 401, site: 401, anon: 401, careB: 403, adminB: PASS },
  }
  const wrong: string[] = []
  for (const r of routes) {
    if (r.declared === 'public' || r.declared === undefined) continue
    const method = r.method === 'ALL' ? 'GET' : r.method
    for (const [who, token] of Object.entries(WHO) as [keyof typeof WHO, string][]) {
      const want = expect[r.declared][who]
      const { status } = await call(fill(r.path), token, { method, ...(method === 'GET' ? {} : { body: '{}' }) })
      const ok = want === PASS ? status !== 401 && status !== 403 && status < 500 : status === want
      if (!ok) wrong.push(`${method} ${r.path} ${who}: ${status}（${want}）`)
    }
  }
  assert.deepEqual(wrong, [])
})

test('care.work: ほかの事業所の利用者は、ケアマネも責任者も 404。責任者は自分の事業所の利用者を読める', { skip }, async () => {
  assert.equal((await call(`/api/clients/${ids.clientA}`, WHO.careB)).status, 404)
  assert.equal((await call(`/api/clients/${ids.clientA}`, WHO.adminB)).status, 404)
  assert.equal((await call(`/api/clients/${ids.clientA}`, WHO.admin)).status, 200)
  assert.equal((await call('/api/clients/abc', WHO.care)).status, 404, 'ID の形でないものも「無い」')
})

test('recording.retention.manage: 録音の保持一覧は責任者だけが見え、事業所外には出ない', { skip }, async () => {
  const own = await call(`/api/office/clients/${ids.clientA}/recordings/retention`, WHO.admin)
  assert.equal(own.status, 200)
  assert.deepEqual(own.body, { recordings: [] })
  assert.equal((await call(`/api/office/clients/${ids.clientA}/recordings/retention`, WHO.care)).status, 403)
  assert.equal((await call(`/api/office/clients/${ids.clientA}/recordings/retention`, WHO.adminB)).status, 404)
})

test('/api/me: 自分の役割でできる操作を返す', { skip }, async () => {
  const me = async (t: string) => ((await call('/api/me', t)).body as { staff: { role: string, operations: string[] } }).staff
  assert.deepEqual((await me(WHO.care)).operations, ['care.work'])
  assert.deepEqual((await me(WHO.admin)).operations, ['care.work', 'staff.manage', 'form.manage', 'recording.retention.manage'])
})

test('staff.manage: 責任者は自分の事業所の職員だけを見て、止める・戻す・役割を変える。止めたらすぐ 401', { skip }, async () => {
  const list = (await call('/api/office/staff', WHO.admin)).body as { staff: { id: string, role: string, disabled: boolean }[] }
  assert.deepEqual(list.staff.map((s) => s.id).sort(), [ids.careA, ids.adminA, ids.disabledA].sort(), 'ほかの事業所の職員は出ない')
  assert.equal(list.staff.find((s) => s.id === ids.disabledA)?.disabled, true)

  const patch = (id: string, body: object, token: string = WHO.admin) => call(`/api/office/staff/${id}`, token, { method: 'PATCH', body: JSON.stringify(body) })
  // 止める → 次のリクエストから 401。戻すと使える
  assert.equal((await patch(ids.careA, { disabled: true })).status, 200)
  assert.equal((await call('/api/clients', WHO.care)).status, 401)
  assert.equal((await patch(ids.careA, { disabled: false })).status, 200)
  assert.equal((await call('/api/clients', WHO.care)).status, 200)
  // 役割を変える → 次のリクエストから効く
  assert.equal((await patch(ids.careA, { role: 'admin' })).status, 200)
  assert.equal((await call('/api/office/staff', WHO.care)).status, 200)
  assert.equal((await patch(ids.careA, { role: 'caremanager' })).status, 200)
  assert.equal((await call('/api/office/staff', WHO.care)).status, 403)
  // ほかの事業所の職員は 404
  assert.equal((await patch(ids.careB, { disabled: true })).status, 404)
  assert.equal((await patch(ids.adminB, { role: 'caremanager' })).status, 404)
  // 自分を止める・自分の役割を変えると 403
  assert.equal((await patch(ids.adminA, { disabled: true })).status, 403)
  assert.equal((await patch(ids.adminA, { role: 'caremanager' })).status, 403)
  // 入力の形が違えば 400
  assert.equal((await patch(ids.careA, {})).status, 400)
  assert.equal((await patch(ids.careA, { role: 'siteAdmin' })).status, 400)
  const self = ((await call('/api/office/staff', WHO.admin)).body as { staff: { id: string, role: string, disabled: boolean }[] }).staff.find((s) => s.id === ids.adminA)
  assert.deepEqual([self?.role, self?.disabled], ['admin', false], '断った直しは当たっていない')
})

test('site.manage: サイト管理者は事業所の一覧を読める。利用者の情報は返さない', { skip }, async () => {
  const me = await call('/api/admin/me', WHO.site)
  assert.equal(me.status, 200)
  assert.deepEqual(me.body, { siteAdmin: { name: 'サイト管理者', email: 'site@example.com' } })
  const offices = (await call('/api/admin/offices', WHO.site)).body as { offices: Record<string, unknown>[] }
  assert.deepEqual(offices.offices.map((o) => o.id).sort(), [ids.officeA, ids.officeB].sort())
  for (const o of offices.offices) assert.deepEqual(Object.keys(o).sort(), ['createdAt', 'id', 'name'])
})

test('staff.manage: 責任者は自分の事業所に職員を登録できる。登録した人はすぐ使える。もう登録されたアカウントは 409', { skip }, async () => {
  const post = (b: object, token: string = WHO.admin) => call('/api/office/staff', token, { method: 'POST', body: JSON.stringify(b) })
  const r = await post({ name: '新しいケアマネ', email: ' New-Care@Example.com ', role: 'caremanager' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.deepEqual([r.body.staff.name, r.body.staff.email, r.body.staff.role, r.body.staff.disabled], ['新しいケアマネ', 'new-care@example.com', 'caremanager', false], 'メールは小文字にそろえる')
  const me = await call('/api/me', 'dev:new-care@example.com')
  assert.equal(me.status, 200)
  assert.deepEqual([me.body.staff.officeId, me.body.staff.role], [ids.officeA, 'caremanager'], '登録した責任者の事業所')
  // ほかの事業所の職員・サイト管理者・同じ人のアカウントは、もう登録されている
  assert.equal((await post({ name: 'x', email: 'other@example.com', role: 'caremanager' })).status, 409)
  assert.equal((await post({ name: 'x', email: 'site@example.com', role: 'admin' })).status, 409)
  assert.equal((await post({ name: 'x', email: 'new-care@example.com', role: 'admin' }, WHO.adminB)).status, 409)
  // 入力の形
  assert.equal((await post({ name: 'x', email: 'not-an-email', role: 'caremanager' })).status, 400)
  assert.equal((await post({ name: '', email: 'a@example.com', role: 'caremanager' })).status, 400)
  assert.equal((await post({ name: 'x', email: 'b@example.com', role: 'siteAdmin' })).status, 400)
})

test('site.manage: サイト管理者は事業所と最初の責任者を登録できる。その責任者は自分の事業所の職員だけを見る', { skip }, async () => {
  const post = (b: object, token: string = WHO.site) => call('/api/admin/offices', token, { method: 'POST', body: JSON.stringify(b) })
  const r = await post({ name: '新しい事業所', phone: '000-0000-0000', admin: { name: '最初の責任者', email: 'first@example.com' } })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.office.name, '新しい事業所')
  assert.deepEqual([r.body.admin.role, r.body.admin.email], ['admin', 'first@example.com'])
  const list = await call('/api/office/staff', 'dev:first@example.com')
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.staff.map((s: { email: string }) => s.email), ['first@example.com'])
  assert.ok(((await call('/api/admin/offices', WHO.site)).body.offices as { id: string }[]).some((o) => o.id === r.body.office.id))
  // もう登録されたアカウントを最初の責任者にすると 409 で、事業所も作らない
  const before = ((await call('/api/admin/offices', WHO.site)).body.offices as unknown[]).length
  assert.equal((await post({ name: '作られない事業所', admin: { name: 'x', email: 'kato@example.com' } })).status, 409)
  assert.equal(((await call('/api/admin/offices', WHO.site)).body.offices as unknown[]).length, before)
  assert.equal((await post({ name: 'x', admin: { name: 'x', email: 'x@example.com' } }, WHO.admin)).status, 403, '責任者は事業所を作れない')
})
