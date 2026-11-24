/** 明示的な --live のみ実モデルへ送信。通常の npm test / CI には含めない。 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { Models, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai'
import { createApp } from '../../api/app.ts'
import { defaultApiDeps } from '../../api/server.ts'
import { DevVerifier } from '../../api/auth.ts'
import { LocalStorage } from '../../api/storage.ts'
import { createPool } from '../../db/pool.ts'
import { migrate } from '../../db/migrate.ts'
import { seedForms } from '../../forms/admin/seed.ts'
import { staffByAuth, createClient } from '../../db/repo.ts'

const { values: args } = parseArgs({ options: { live: { type: 'boolean' }, resume: { type: 'boolean' }, out: { type: 'string' }, limit: { type: 'string', default: '1' } } })
if (!args.live || !args.out) throw new Error('明示的な --live --out が必要です。先に公式料金を確認してください。')
const limit = Number(args.limit)
if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error('limit は1〜12')
const connection = process.env.EVAL_DATABASE_URL
if (!connection || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname)) throw new Error('EVAL_DATABASE_URL はローカルDBに限定')
const env = { ...process.env, GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT, AI_PROVIDER: 'vertex', GEMINI_MODEL: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash', GEMINI_LOCATION: process.env.GEMINI_LOCATION ?? 'global' }
if (!env.GOOGLE_CLOUD_PROJECT || env.GEMINI_MODEL !== 'gemini-3.8-flash' || env.GEMINI_LOCATION !== 'global') throw new Error('料金確認済みのプロジェクト・gemini-3.8-flash・global を明示してください')
const out = resolve(args.out)
await mkdir(out, { recursive: true })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8')) as { id: string, values: Record<string, unknown>, expected: unknown }[]
const ledgerPath = join(out, 'ledger.json')
const ledger: { sent: number, caseKeys: string[] } = args.resume ? JSON.parse(await readFile(ledgerPath, 'utf8')) : { sent: 0, caseKeys: [] }
if (!args.resume) {
  try { await readFile(ledgerPath); throw new Error('既存ledgerがあります。上書きしません。') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
}
// 12回 × 入力8000トークン・出力8192トークンの保守的見積もり。公式通常料金（global、2026-12-31まで）。
const plannedUsd = 12 * (8000 * .75 + 8192 * 3.75) / 1e6
if (plannedUsd > 1) throw new Error('予算見積もりが1 USDを超えています')
let active: { key: string, captured?: Record<string, unknown> } | undefined
const proto = Models.prototype as unknown as { generateContentInternal: (params: GenerateContentParameters) => Promise<GenerateContentResponse> }
const original = proto.generateContentInternal
if (typeof original !== 'function') throw new Error('SDKの観測箇所が変わっています。実行を停止します。')
// 実SDKへ委譲する観測ラッパー。応答を偽造せず、プロンプト・生成条件を変更しない。
// SDKの非公開メソッドに依存するため版を固定し、実行前に存在確認する。
proto.generateContentInternal = async function (params) {
  if (!active || active.captured || ledger.sent >= limit || ledger.sent >= 12) throw new Error('追加呼出・再試行を停止')
  const context = active
  const inputBytes = Buffer.byteLength(JSON.stringify(params.contents))
  if (inputBytes > 7500) throw new Error('入力が見積もり上限を超えています')
  context.captured = { startedAt: new Date().toISOString(), requestedModel: params.model, inputBytes, promptSha256: hash(JSON.stringify(params.contents)), generationConfig: { temperature: params.config?.temperature, maxOutputTokens: params.config?.maxOutputTokens, responseMimeType: params.config?.responseMimeType } }
  if (JSON.stringify(params.contents).includes('保存版には含めない')) throw new Error('保存版以外の値が混ざっています')
  ledger.sent++; ledger.caseKeys.push(context.key)
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2))
  const started = performance.now()
  try {
    const result = await original.call(this, { ...params, config: { ...params.config, httpOptions: { ...params.config?.httpOptions, timeout: 120_000, retryOptions: { attempts: 1 } } } })
    Object.assign(context.captured, { elapsedMs: Math.round(performance.now() - started), responseId: result.responseId, modelVersion: result.modelVersion, usage: result.usageMetadata, finishReasons: result.candidates?.map((c) => c.finishReason), text: result.text ?? '' })
    return result
  } catch (e) {
    Object.assign(context.captured, { elapsedMs: Math.round(performance.now() - started), error: { name: (e as Error).name, status: (e as { status?: number }).status, code: (e as { code?: number }).code } })
    throw e
  }
}
const schema = `eval_cp_live_${randomUUID().replaceAll('-', '')}`
const admin = await createPool({ DATABASE_URL: connection })
await admin.query(`CREATE SCHEMA ${schema}`)
const db = await createPool({ DATABASE_URL: connection, DB_SCHEMA: schema })
const dir = await mkdtemp(join(tmpdir(), 'cp-live-'))
let failed = false
try {
  await migrate(db); await seedForms(db)
  const office = (await db.query("INSERT INTO offices(name) VALUES ('架空品質検証事業所') RETURNING id")).rows[0]
  const email = 'careplan-eval@example.com'
  await db.query("INSERT INTO staff(office_id,auth_uid,name,email) VALUES ($1,$2,'架空の検証担当',$3)", [office.id, `dev:${email}`, email])
  const staff = (await staffByAuth(db, `dev:${email}`))!
  const app = createApp({ db: async () => db, verifier: () => new DevVerifier(), storage: () => new LocalStorage(dir), queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }), carePlanAi: defaultApiDeps(env).carePlanAi, devAuth: true })
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const start = performance.now()
    const response = await app.request(path, { method, headers: { Authorization: `Bearer dev:${email}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, elapsedMs: Math.round(performance.now() - start), data: await response.json() }
  }
  for (const scenario of cases) {
    if (ledger.sent >= limit) break
    const made = await createClient(db, staff, { name: `架空検証${scenario.id}`, sex: '女' })
    const changes = Object.entries(scenario.values).map(([key, value]) => ({ key, value, base: null }))
    if (changes.length) { const r = await call(`/api/documents/${made.documentId}/fields`, 'PATCH', { changes }); if (r.status !== 200) throw new Error(`fixture ${scenario.id}: ${r.status}`) }
    const saved = await call(`/api/documents/${made.documentId}/save`, 'POST', { scope: 'document' })
    if (saved.status !== 200) throw new Error(`save ${saved.status}`)
    const source = (await db.query('SELECT id,rev FROM revisions WHERE document_id=$1 ORDER BY rev DESC LIMIT 1', [made.documentId])).rows[0]
    await db.query("UPDATE revisions SET saved_at='2026-11-20T00:00:00Z' WHERE id=$1", [source.id])
    const originalComplaint = scenario.values['complaint.person'] ?? null
    await call(`/api/documents/${made.documentId}/fields`, 'PATCH', { changes: [{ key: 'complaint.person', value: '保存版には含めない、後からの変更。', base: originalComplaint }] })
    await call(`/api/documents/${made.documentId}/save`, 'POST', { scope: 'document' })
    for (let repeat = 1; repeat <= 2; repeat++) {
      const key = `${scenario.id}${repeat}`
      if (ledger.caseKeys.includes(key)) continue
      if (ledger.sent >= limit) break
      const created = await call(`/api/clients/${made.id}/care-plans`, 'POST', { effectiveFrom: '2026-11-01', effectiveTo: '2027-10-31' })
      if (created.status !== 201) throw new Error(`plan ${created.status}`)
      const plan = created.data.plan
      active = { key }
      const generated = await call(`/api/care-plans/${plan.id}/ai-drafts`, 'POST', { sourceDocumentId: made.documentId, sourceRevisionId: Number(source.id) })
      const captured = active.captured
      active = undefined
      const draft = generated.data.draft
      const afterGenerate = await call(`/api/care-plans/${plan.id}`)
      const count = ledger.sent
      const reopened = draft ? await call(`/api/care-plans/${plan.id}/ai-drafts/${draft.id}`) : null
      const againOpened = draft ? await call(`/api/care-plans/${plan.id}/ai-drafts/${draft.id}`) : null
      const doc1 = plan.documents.find((d: { formNo: number }) => d.formNo === 1).documentId
      const human = '人が編集した方針（検証用・保持）'
      const humanEdit = await call(`/api/documents/${doc1}/fields`, 'PATCH', { changes: [{ key: 'plan.overallPolicy', value: human, base: plan.plan1['plan.overallPolicy'] ?? null }] })
      const adopted = draft ? await call(`/api/care-plans/${plan.id}/ai-drafts/${draft.id}/apply`, 'POST', { baseVersion: plan.lockVersion }) : null
      const after = (await call(`/api/care-plans/${plan.id}`)).data.plan
      const double = adopted?.status === 200 ? await call(`/api/care-plans/${plan.id}/ai-drafts/${draft.id}/apply`, 'POST', { baseVersion: after.lockVersion }) : null
      const record = { key, scenario: scenario.id, repeat, synthetic: true, environment: { provider: env.AI_PROVIDER, model: env.GEMINI_MODEL, location: env.GEMINI_LOCATION, projectSha256: hash(env.GOOGLE_CLOUD_PROJECT), auth: 'ADC', plannedUpperEstimateUsd: plannedUsd }, captured,
        generated: { status: generated.status, elapsedMs: generated.elapsedMs, draft },
        checks: { fixedRevision: draft?.sourceRevisionId === Number(source.id), noAutoApply: JSON.stringify(afterGenerate.data.plan.plan1) === JSON.stringify(plan.plan1) && afterGenerate.data.plan.needs.length === 0 && afterGenerate.data.plan.slots.length === 0 && afterGenerate.data.plan.status === 'draft', reopenWithoutCall: count === ledger.sent && reopened?.status === 200 && againOpened?.status === 200, manualEdit: humanEdit.status === 200, humanPreserved: after.plan1['plan.overallPolicy'] === human, stillDraft: after.status === 'draft', noDoubleApply: double ? JSON.stringify(double.data.plan.needs) === JSON.stringify(after.needs) && JSON.stringify(double.data.plan.slots) === JSON.stringify(after.slots) : null },
        adopted: adopted ? { status: adopted.status, elapsedMs: adopted.elapsedMs, applied: adopted.data.applied, error: adopted.data.error } : null,
        persisted: { plan1: after.plan1, needs: after.needs, slots: after.slots }, expected: scenario.expected }
      await writeFile(join(out, `${key}.json`), JSON.stringify(record, null, 2))
      console.log(JSON.stringify({ key, realRequests: ledger.sent, status: generated.status, draft: draft?.status, apply: adopted?.status, ms: generated.elapsedMs, usage: captured?.usage }))
      if (!captured || captured.error) { failed = true; break }
    }
    if (failed) break
  }
} finally {
  proto.generateContentInternal = original
  await db.end()
  await admin.query(`DROP SCHEMA ${schema} CASCADE`)
  await admin.end()
  await rm(dir, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
