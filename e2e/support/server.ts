import { fakeModel } from '../../api/chat.ts'
// E2E専用: 実API・独立したDBスキーマ・一時ストレージを起動する。本番依存は接続しない。
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { createPool } from '../../db/pool.ts'
import { migrate } from '../../db/migrate.ts'
import { seed } from '../../db/seed.ts'
import { createApiServer } from '../../api/server.ts'
import { DevVerifier } from '../../api/auth.ts'
import { LocalStorage } from '../../api/storage.ts'
import { ensurePdf } from '../../forms/admin/pdf.ts'
import { readMeta } from '../../forms/admin/files.ts'
import { putFormAssets } from '../../forms/admin/assets.ts'

const connection = process.env.E2E_DATABASE_URL
if (!connection) throw new Error('E2E_DATABASE_URL にローカルのテスト用 PostgreSQL を指定してください。通常の .env は読みません。')
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname)) {
  throw new Error('E2E はローカルの PostgreSQL のみ使用できます。')
}
const schema = `e2e_care_plan_${randomUUID().replaceAll('-', '')}`
const admin = await createPool({ DATABASE_URL: connection })
const db = await createPool({ DATABASE_URL: connection, DB_SCHEMA: schema })
const root = await mkdtemp(join(tmpdir(), 'care-plan-e2e-'))
const storage = new LocalStorage(root)
let api: ReturnType<typeof createApiServer> | undefined
let vite: Awaited<ReturnType<typeof createServer>> | undefined
let closing: Promise<void> | undefined
function close() {
  return closing ??= (async () => {
    await vite?.close()
    if (api?.listening) await new Promise<void>((resolve) => api!.close(() => resolve()))
    await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  })()
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().then(() => process.exit(0)) })
try {
  await admin.query(`CREATE SCHEMA ${schema}`)
  await migrate(db)
  await seed(db, { email: 'e2e@example.com', officeName: 'E2E架空事業所' })
  for (const kind of ['assessment', 'care_plan_1', 'care_plan_2', 'care_plan_3', 'care_plan_4', 'care_plan_5', 'care_plan_6', 'care_plan_7']) {
    const { pdf, message } = await ensurePdf(kind)
    if (!pdf) throw new Error(message)
    await putFormAssets(storage, readMeta(kind), pdf)
  }
  api = createApiServer({
    db: async () => db, verifier: () => new DevVerifier(), storage: () => storage,
    // E2E-only scripted record model. Production uses the configured existing Gemini adapter.
    chat: async () => async req => {
      const meeting = req.system.includes('サービス担当者会議の要点 第4表')
      if (!meeting && !req.system.includes('居宅介護支援経過 第5表')) return fakeModel(req)
      if (req.contents.some(c => c.parts.some(p => p.functionCall?.name === 'propose_edit'))) return [{ text: '架空のテスト用候補です。日時は確認してください。' }]
      return [{ functionCall: { name: 'propose_edit', args: { key: meeting ? 'meeting.remaining' : 'progress.content', value: 'AIによる架空の下書き。未決定事項は次回確認する。' } } }]
    },
    carePlanAi: async () => async () => ({
      plan1: { 'plan.overallPolicy': '架空の方針：自宅で安全に暮らす' },
      needs: [{ need: '架空の入浴支援', longGoal: { goal: '自宅で暮らす' }, shortGoals: [{ goal: '安全に入浴する', services: [{ content: '架空の入浴介助', insured: true, kind: '訪問介護' }] }] }],
      slots: [{ serviceRef: { need: 0, shortGoal: 0, service: 0 }, scheduleType: 'weekly', weekday: 1, start: '09:00', end: '10:00' }], conflicts: [],
    }),
    queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }), devAuth: true,
  })
  api.listen(0, '127.0.0.1')
  await once(api, 'listening')
  const address = api.address()
  if (!address || typeof address === 'string') throw new Error('API のポートを取得できません')
  vite = await createServer({
    configFile: false,
    plugins: [(await import('@vitejs/plugin-react')).default()],
    server: { host: '127.0.0.1', port: 4178, strictPort: true, proxy: { '/api/': `http://127.0.0.1:${address.port}` } },
  })
  await vite.listen()
  console.log('E2E ready: http://127.0.0.1:4178 (isolated schema / temporary storage)')
} catch (error) {
  await close()
  throw error
}
