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
  const source = await ensurePdf('care_plan_5')
  assert.ok(source.pdf)
  await putFormAssets(new LocalStorage(root), readMeta('care_plan_5'), source.pdf, { images: false })
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
