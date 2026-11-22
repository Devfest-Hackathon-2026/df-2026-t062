/** 保存済み実モデル出力のUIリプレイ。追加のGemini呼出は行わない。 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'vite'
import { createPool } from '../../db/pool.ts'
import { migrate } from '../../db/migrate.ts'
import { seedForms } from '../../forms/admin/seed.ts'
import { createClient, staffByAuth } from '../../db/repo.ts'
import { createApiServer } from '../../api/server.ts'
import { DevVerifier } from '../../api/auth.ts'
import { LocalStorage } from '../../api/storage.ts'
import { ensurePdf } from '../../forms/admin/pdf.ts'
import { readMeta } from '../../forms/admin/files.ts'
import { putFormAssets } from '../../forms/admin/assets.ts'
import { createCarePlan, saveCarePlan, createCarePlanAiDraft } from '../../db/care-plans.ts'
const connection = process.env.EVAL_DATABASE_URL
if (!connection || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname)) throw new Error('ローカルDBが必要です')
const record = JSON.parse(await readFile(resolve(process.argv[2] ?? '.data/care-plan-real-gemini-20261122/F1.json'), 'utf8'))
if (!record.synthetic || !record.captured?.responseId) throw new Error('架空データの実モデル記録を指定してください')
const schema = `eval_cp_ui_${randomUUID().replaceAll('-', '')}`
const admin = await createPool({ DATABASE_URL: connection }); await admin.query(`CREATE SCHEMA ${schema}`)
const db = await createPool({ DATABASE_URL: connection, DB_SCHEMA: schema })
const root = await mkdtemp(join(tmpdir(), 'cp-ui-replay-'))
const storage = new LocalStorage(root)
await migrate(db); await seedForms(db)
const office = (await db.query("INSERT INTO offices(name) VALUES ('架空UI検証事業所') RETURNING id")).rows[0]
const email = 'cp-ui@example.com'
await db.query("INSERT INTO staff(office_id,auth_uid,name,email) VALUES ($1,$2,'架空担当',$3)", [office.id, `dev:${email}`, email])
const staff = (await staffByAuth(db, `dev:${email}`))!
const client = await createClient(db, staff, { name: '架空検証F', sex: '女' })
const { saveDocument } = await import('../../db/repo.ts')
await saveDocument(db, staff, client.documentId, { scope: 'document' })
const rev = (await db.query('SELECT id FROM revisions WHERE document_id=$1 ORDER BY rev DESC LIMIT 1', [client.documentId])).rows[0].id
let plan = await createCarePlan(db, staff, client.id, { effectiveFrom: '2026-11-01', effectiveTo: '2027-10-31', copyFromPlanId: null })
plan = (await saveCarePlan(db, staff, plan.id, plan.lockVersion)).plan
await createCarePlanAiDraft(db, staff, plan.id, client.documentId, Number(rev), async () => record.generated.draft.proposal)
for (const kind of ['assessment', 'care_plan_1', 'care_plan_2', 'care_plan_3']) {
  const { pdf, message } = await ensurePdf(kind)
  if (!pdf) throw new Error(message)
  await putFormAssets(storage, readMeta(kind), pdf)
}
const api = createApiServer({ db: async () => db, verifier: () => new DevVerifier(), storage: () => storage,
  queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }),
  carePlanAi: async () => async () => { throw new Error('リプレイ画面から再生成はしません') }, devAuth: true })
api.listen(0, '127.0.0.1'); await once(api, 'listening')
const address = api.address()
if (!address || typeof address === 'string') throw new Error('API port')
const vite = await createServer({ configFile: false, plugins: [(await import('@vitejs/plugin-react')).default()], server: { host: '127.0.0.1', port: 15301, strictPort: true, proxy: { '/api/': `http://127.0.0.1:${address.port}` } } })
await vite.listen()
console.log(JSON.stringify({ url: `http://127.0.0.1:15301/clients/${client.id}?ui=pc`, email, sourceResponseId: record.captured.responseId, realModelCalls: 0 }))
let closing = false
const close = async () => { if (closing) return; closing = true; await vite.close(); await new Promise<void>((done) => api.close(() => done())); await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(root, { recursive: true, force: true }); process.exit() }
process.on('SIGINT', close); process.on('SIGTERM', close)
