import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createPool, type Db } from '../db/pool.ts'
import { migrate } from '../db/migrate.ts'
import { seed } from '../db/seed.ts'
import { createApiServer } from '../api/server.ts'
import { DevVerifier } from '../api/auth.ts'
import { LocalStorage } from '../api/storage.ts'
const url = process.env.DATABASE_URL
const skip = !url
const schema = `t_care_record_${process.pid}`
let db: Db, origin = '', clientId = '', root = ''
let stop = async () => {}
const token = 'Bearer dev:records@example.com'
const call = async (path: string, method = 'GET', value?: unknown, auth = token) => {
  const r = await fetch(origin + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) })
  return { status: r.status, body: (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : await r.arrayBuffer() }
}
before(async () => {
  if (!url) return
  const admin = await createPool({ DATABASE_URL: url }); await admin.query(`CREATE SCHEMA ${schema}`); await admin.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema }); await migrate(db)
  const a = await seed(db, { email: 'records@example.com' }); clientId = a.clients.sato
  await seed(db, { email: 'other-records@example.com', officeName: '別事業所' })
  root = await mkdtemp(join(tmpdir(), 'care-record-test-'))
  const { ensurePdf } = await import('../forms/admin/pdf.ts')
  const { putFormAssets } = await import('../forms/admin/assets.ts')
  const { readMeta } = await import('../forms/admin/files.ts')
  for (const kind of ['care_plan_4', 'care_plan_5']) {
    const source = await ensurePdf(kind)
    assert.ok(source.pdf)
    await putFormAssets(new LocalStorage(root), readMeta(kind), source.pdf, { images: false })
  }
  const server = createApiServer({ db: async () => db, verifier: () => new DevVerifier(), storage: () => new LocalStorage(root), devAuth: true, queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`
  stop = () => new Promise<void>(resolve => server.close(() => resolve()))
})
after(async () => { if (!url) return; await stop(); await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); await rm(root, { recursive: true, force: true }) })

test('第5表の記録: 同日時の独立ID、再送の重複防止、時系列・検索、履歴、競合、事業所境界', { skip }, async () => {
  const path = `/api/clients/${clientId}/care-records`
  assert.equal((await call(path)).status, 200)
  assert.equal((await call(path, 'GET', undefined, '')).status, 401)
  assert.equal((await call(path, 'GET', undefined, 'Bearer dev:other-records@example.com')).status, 404)
  assert.equal((await call(`/api/clients/${randomUUID()}/care-records`)).status, 404)
  await db.query("INSERT INTO site_admins (auth_uid,name,email) VALUES ('dev:site-records@example.com','管理者','site-records@example.com')")
  assert.equal((await call(path, 'GET', undefined, 'Bearer dev:site-records@example.com')).status, 401)
  await db.query("UPDATE staff SET disabled_at=now() WHERE email='records@example.com'")
  assert.equal((await call(path)).status, 401)
  await db.query("UPDATE staff SET disabled_at=NULL WHERE email='records@example.com'")
  const requestId = randomUUID()
  const first = await call(path, 'POST', { kind: 'care_plan_5', requestId })
  assert.equal(first.status, 201)
  const id = first.body.id
  assert.equal((await call(path, 'POST', { kind: 'care_plan_5', requestId })).body.id, id)
  const second = await call(path, 'POST', { kind: 'care_plan_5', requestId: randomUUID() })
  assert.notEqual(second.body.id, id)
  for (const recordId of [id, second.body.id]) {
    const r = await call(`/api/documents/${recordId}/fields`, 'PATCH', [
    ])
    // General field API expects a changes object; malformed payload never changes a record.
    assert.equal(r.status, 400)
    const patched = await call(`/api/documents/${recordId}/fields`, 'PATCH', { changes: [
      { key: 'progress.date', value: '2026-11-22', base: null },
      { key: 'progress.time', value: '10:30', base: null },
      { key: 'progress.category', value: '電話（受信）', base: null },
      { key: 'progress.content', value: '本人から相談あり。結論は次回確認する。', base: null },
    ] })
    assert.equal(patched.status, 200)
    assert.equal((await call(`/api/documents/${recordId}/save`, 'POST', { scope: 'document' })).status, 200)
  }
  const list = (await call(path + '?q=' + encodeURIComponent('結論は次回'))).body
  assert.equal(list.records.length, 2)
  assert.deepEqual(new Set(list.records.map((r: { id: string }) => r.id)), new Set([id, second.body.id]))
  assert.equal((await call(path + '?from=2026-11-23')).body.records.length, 0)
  assert.equal((await call(path + '?from=2026-02-30')).status, 400)
  const invalidTime = await call(`/api/documents/${id}/fields`, 'PATCH', { changes: [{ key: 'progress.time', value: '25:89', base: '10:30' }] })
  assert.equal(invalidTime.status, 400)
  const scope = (await db.query('SELECT office_id, client_id FROM documents WHERE id=$1', [id])).rows[0]
  const otherClient = (await db.query('SELECT id FROM clients WHERE id<>$1 LIMIT 1', [scope.client_id])).rows[0].id
  await assert.rejects(db.query('INSERT INTO care_record_creations (office_id,client_id,request_id,document_id) VALUES ($1,$2,$3,$4)', [scope.office_id, otherClient, randomUUID(), id]), { code: '23514' })
  const before = await call(`/api/care-records/${id}/revisions/1`)
  assert.equal(before.status, 200)
  assert.equal(before.body.revision.values['progress.content'], '本人から相談あり。結論は次回確認する。')
  assert.equal((await call(`/api/documents/${id}/fields`, 'PATCH', { changes: [{ key: 'progress.content', value: '人が訂正した文章', base: before.body.revision.values['progress.content'] }] })).status, 200)
  assert.equal((await call(`/api/documents/${id}/fields`, 'PATCH', { changes: [{ key: 'progress.content', value: '古い画面から上書き', base: before.body.revision.values['progress.content'] }] })).status, 409)
  await call(`/api/documents/${id}/save`, 'POST', { scope: 'document' })
  assert.equal((await call(`/api/care-records/${id}/revisions/1`)).body.revision.values['progress.content'], before.body.revision.values['progress.content'])
  assert.equal((await call(`/api/care-records/${id}/revisions/2`)).body.revision.values['progress.content'], '人が訂正した文章')
  assert.equal((await call(`/api/care-records/${id}/revisions/1`, 'GET', undefined, 'Bearer dev:other-records@example.com')).status, 404)
  assert.equal((await call(`/api/care-records/${id}/revisions/999`)).status, 404)
  const oldPdf = await call(`/api/documents/${id}/pdf?rev=1`)
  assert.equal(oldPdf.status, 200)
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: new Uint8Array(oldPdf.body) })
  const pdf = await loading.promise
  let printed = ''
  for (let n=1;n<=pdf.numPages;n++) printed += (await (await pdf.getPage(n)).getTextContent()).items.map(i => 'str' in i ? i.str : '').join('')
  assert.ok(printed.includes('本人から相談あり'))
  assert.ok(!printed.includes('人が訂正した文章'))
  await loading.destroy()
  assert.equal((await call(`/api/documents/${id}/pdf?rev=999`)).status, 404)
})

test('第4表: 複数会議の分離、出席者・検討と結論・残課題の保存、過去版と別事業所の遮断', { skip }, async () => {
  const path = `/api/clients/${clientId}/care-records`
  const requestId = randomUUID()
  const first = await call(path, 'POST', { kind: 'care_plan_4', requestId })
  assert.equal(first.status, 201)
  const id = first.body.id
  assert.equal((await call(path, 'POST', { kind: 'care_plan_4', requestId })).body.id, id)
  assert.equal((await call(path, 'POST', { kind: 'care_plan_5', requestId })).status, 409)
  const second = await call(path, 'POST', { kind: 'care_plan_4', requestId: randomUUID() })
  assert.notEqual(id, second.body.id)
  const values = {
    'meeting.date': '2026-11-22', 'meeting.start': '14:00', 'meeting.end': '15:00', 'meeting.place': '架空会議室', 'meeting.number': 2,
    'meeting.personAttended': '出席', 'meeting.familyAttended': '欠席', 'meeting.relationship': '妻',
    'meeting.attendees': [{ id: randomUUID(), name: '架空 看護師', profession: '看護師', affiliation: '架空訪問看護' }],
    'meeting.items': '外出時の不安', 'meeting.discussion': '頻度の見直しを検討したが、まだ合意していない。', 'meeting.conclusion': '次回に状況を確認することに合意。', 'meeting.remaining': '頻度は未決定。', 'meeting.nextDate': '来月調整',
  }
  assert.equal((await call(`/api/documents/${id}/fields`, 'PATCH', { changes: Object.entries(values).map(([key, value]) => ({ key, value, base: null })) })).status, 200)
  assert.equal((await call(`/api/documents/${id}/save`, 'POST', { scope: 'document' })).status, 200)
  const old = (await call(`/api/care-records/${id}/revisions/1`)).body.revision
  for (const [key, value] of Object.entries(values)) assert.deepEqual(old.values[key], value)
  const list = (await call(path + '?kind=care_plan_4&q=' + encodeURIComponent('まだ合意'))).body.records
  assert.deepEqual(list.map((r: { id: string }) => r.id), [id])
  assert.ok(!(await call(path)).body.records.some((r: { id: string }) => r.id === id))
  assert.equal((await call(`/api/documents/${id}/fields`, 'PATCH', { changes: [{ key: 'meeting.remaining', base: values['meeting.remaining'], value: '人が追記した残課題。' }] })).status, 200)
  await call(`/api/documents/${id}/save`, 'POST', { scope: 'document' })
  assert.equal((await call(`/api/care-records/${id}/revisions/1`)).body.revision.values['meeting.remaining'], values['meeting.remaining'])
  assert.equal((await call(`/api/care-records/${id}/revisions/1`, 'GET', undefined, 'Bearer dev:other-records@example.com')).status, 404)
  const pdf = await call(`/api/documents/${id}/pdf?rev=1`)
  assert.equal(pdf.status, 200)
})

test('第4/5表: 保存と明示確定を分離し、未保存変更/競合/越境を拒否して過去の確定を保持する', { skip }, async () => {
  const id = (await call(`/api/clients/${clientId}/care-records`, 'POST', {kind:'care_plan_5',requestId:randomUUID()})).body.id
  const confirm = (baseRevision:number,auth=token) => call(`/api/care-records/${id}/confirm`,'POST',{baseRevision,relatedPlanId:null},auth)
  assert.equal((await confirm(1)).status,409)
  await call(`/api/documents/${id}/fields`,'PATCH',{changes:[{key:'progress.content',base:null,value:'架空の確認対象'}]})
  await call(`/api/documents/${id}/save`,'POST',{scope:'document'})
  assert.equal((await confirm(1,'Bearer dev:other-records@example.com')).status,404)
  assert.equal((await confirm(1,'')).status,401)
  const first=await confirm(1);assert.equal(first.status,200,JSON.stringify(first.body))
  assert.ok(first.body.confirmation.confirmedAt)
  assert.deepEqual((await confirm(1)).body.confirmation,first.body.confirmation)
  await call(`/api/documents/${id}/fields`,'PATCH',{changes:[{key:'progress.content',base:'架空の確認対象',value:'架空の修正'}]})
  await call(`/api/documents/${id}/save`,'POST',{scope:'document'})
  const second=(await call(`/api/care-records/${id}/revisions/2`)).body.revision
  assert.equal(second.confirmation,null)
  assert.equal((await confirm(1)).status,409)
  await call(`/api/documents/${id}/fields`,'PATCH',{changes:[{key:'progress.content',base:'架空の修正',value:'未保存の変更'}]})
  assert.equal((await confirm(2)).status,409)
  const old=(await call(`/api/care-records/${id}/revisions/1`)).body.revision
  assert.deepEqual(old.confirmation,first.body.confirmation)
  await assert.rejects(db.query('DELETE FROM care_record_confirmations WHERE document_id=$1',[id]),{code:'23514'})
})

test('第4表: 関連計画は同じ利用者の確定スナップショットだけを参照し、計画改定後も保持する', {skip}, async()=>{
  const createPlan=async(id=clientId)=>{
    const created=await call(`/api/clients/${id}/care-plans`,'POST',{effectiveFrom:'2026-11-01'});assert.equal(created.status,201)
    const plan=created.body.plan
    const saved=await call(`/api/care-plans/${plan.id}/save`,'POST',{baseVersion:plan.lockVersion});assert.equal(saved.status,200)
    assert.equal((await call(`/api/care-plans/${plan.id}/confirm`,'POST',{baseVersion:saved.body.plan.lockVersion})).status,200)
    return plan
  }
  const plan=await createPlan()
  const other=(await call('/api/clients','POST',{name:'架空別利用者',sex:'女'})).body.id
  const foreign=await createPlan(other)
  const id=(await call(`/api/clients/${clientId}/care-records`,'POST',{kind:'care_plan_4',requestId:randomUUID()})).body.id
  await call(`/api/documents/${id}/save`,'POST',{scope:'document'})
  const confirm=(relatedPlanId:string)=>call(`/api/care-records/${id}/confirm`,'POST',{baseRevision:1,relatedPlanId})
  assert.equal((await confirm(foreign.id)).status,404)
  assert.equal((await confirm(randomUUID())).status,404)
  const r=await confirm(plan.id);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.confirmation.planId,plan.id);assert.equal(r.body.confirmation.planVersion,plan.version)
  await createPlan()
  const past=(await call(`/api/care-records/${id}/revisions/1`)).body.revision
  assert.deepEqual(past.confirmation,r.body.confirmation)
  assert.equal((await confirm(foreign.id)).status,409)
})


test('復活した記録の一覧・原案・保存版を閲覧するとアクセス監査に残す', { skip }, async () => {
  const record = await call(`/api/clients/${clientId}/care-records`, 'POST', { kind: 'care_plan_5', requestId: randomUUID() })
  assert.equal(record.status, 201)
  const id = record.body.id
  assert.equal((await call(`/api/documents/${id}/save`, 'POST', { scope: 'document' })).status, 200)
  const paths = [`/api/clients/${clientId}/care-records`, `/api/care-records/${id}/ai-drafts`, `/api/care-records/${id}/revisions/1`]
  for (const path of paths) assert.equal((await call(path)).status, 200)
  const events = (await db.query(`SELECT route,client_id,document_id FROM access_audit_events
    WHERE client_id=$1 AND route IN ('/api/clients/:id/care-records','/api/care-records/:id/ai-drafts','/api/care-records/:id/revisions/:rev')`, [clientId])).rows
  for (const route of ['/api/clients/:id/care-records','/api/care-records/:id/ai-drafts','/api/care-records/:id/revisions/:rev']) {
    assert.ok(events.some(e => e.route === route && (route.includes('/clients/') || e.document_id === id)))
  }
  const before = events.length
  assert.equal((await call(`/api/care-records/${id}/ai-drafts`, 'GET', undefined, 'Bearer dev:other-records@example.com')).status, 404)
  assert.equal(Number((await db.query(`SELECT count(*) AS n FROM access_audit_events WHERE client_id=$1 AND route IN ('/api/clients/:id/care-records','/api/care-records/:id/ai-drafts','/api/care-records/:id/revisions/:rev')`, [clientId])).rows[0].n), before)
})
