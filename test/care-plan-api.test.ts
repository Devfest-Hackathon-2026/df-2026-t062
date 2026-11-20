// ケアプラン（#90）の API の通し。計画版の作成・読み取り・第2表の stable ID・保存・AI 原案の根拠と適用。
// PostgreSQL が要る（DATABASE_URL がなければ飛ばす）。ファイルごとに別のスキーマを使う。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Db } from '../db/pool.ts'
import type { Storage } from '../api/storage.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_careplan_api_${process.pid}`
const TOKEN = 'Bearer dev:careplan@example.com'
const OTHER = 'Bearer dev:careplan-other@example.com'

let db: Db
let origin = ''
let close = async () => {}
let clients: Record<string, string> = {}
let assessmentRevision: { id: number, rev: number, documentId: string } = { id: 0, rev: 0, documentId: '' }
type AiMode = 'ok' | 'throw' | 'invalid'
let aiMode: AiMode = 'ok'
let aiCalls = 0
let aiProposal: unknown = {}
let storage: Storage

const call = async (path: string, init: RequestInit & { token?: string } = {}) => {
  const res = await fetch(`${origin}${path}`, {
    ...init,
    headers: { Authorization: init.token ?? TOKEN, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.arrayBuffer() }
}

const post = (path: string, body: unknown, token?: string) => call(path, { method: 'POST', body: JSON.stringify(body), token })
const put = (path: string, body: unknown) => call(path, { method: 'PUT', body: JSON.stringify(body) })
const patch = (path: string, body: unknown) => call(path, { method: 'PATCH', body: JSON.stringify(body) })

interface PlanDoc { formNo: 1 | 2 | 3, documentId: string, formVersionId: string, latestRevision: number }
interface PlanBody {
  id: string
  clientId: string
  planSeriesId: string
  version: number
  status: string
  effectiveFrom: string
  effectiveTo: string | null
  previousPlanId: string | null
  lockVersion: number
  hasUnsavedChanges: boolean
  documents: PlanDoc[]
  plan1?: Record<string, unknown>
  needs?: NeedBody[]
  slots?: unknown[]
  aiDraft?: { id: string, status: string, sourceRevisionId: number } | null
}
interface NeedBody {
  id: string
  need: string
  longGoal: { id: string, goal: string, periodText: string | null, periodFrom: string | null, periodTo: string | null }
  shortGoals: { id: string, goal: string, services: { id: string, content: string }[] }[]
}
interface DraftBody {
  draft: {
    id: string
    status: string
    sourceDocumentId: string
    sourceRevisionId: number
    sourceRevisionRev: number
    proposal: unknown
    errorKind: string | null
  }
}

const createPlan = async (clientId: string, input: Record<string, unknown> = {}) => {
  const r = await post(`/api/clients/${clientId}/care-plans`, { effectiveFrom: '2026-04-01', effectiveTo: '2027-03-31', ...input })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return (r.body as { plan: PlanBody }).plan
}

const getPlan = async (planId: string, token?: string) => {
  const r = await call(`/api/care-plans/${planId}`, { token })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return (r.body as { plan: PlanBody }).plan
}

const planDoc = (plan: PlanBody, formNo: 1 | 2 | 3) => plan.documents.find((d) => d.formNo === formNo)!

const savePlan = (plan: PlanBody) => post(`/api/care-plans/${plan.id}/save`, { baseVersion: plan.lockVersion })

const needPayload = (suffix = '') => [{
  need: `入浴が一人でできない${suffix}`,
  longGoal: { goal: '安全に入浴できる', periodText: '2026年4月〜2027年3月', periodFrom: '2026-04-01', periodTo: '2027-03-31' },
  shortGoals: [
    {
      goal: '手すりを使って浴槽をまたげる',
      periodText: '2026年4月〜2026年9月',
      periodFrom: '2026-04-01',
      periodTo: '2026-09-30',
      services: [{
        content: '入浴介助', insured: true, kind: '訪問介護', provider: '見本事業所', frequency: '週2回',
        periodText: '2026年4月〜2027年3月', periodFrom: '2026-04-01', periodTo: '2027-03-31',
      }],
    },
    {
      goal: '浴室の温度を自分で確かめる',
      periodText: '2026年4月〜2026年9月',
      periodFrom: '2026-04-01',
      periodTo: '2026-09-30',
      services: [{ content: '福祉用具貸与', insured: true, kind: '福祉用具貸与', frequency: '月1回' }],
    },
  ],
}]

/** 試験用の最小の様式。pdfme の見た目は使わず、欄の key だけを本物に合わせる */
function planForm(kind: string, keys: string[]) {
  return {
    kind,
    name: `${kind} 試験`,
    title: `${kind} 試験`,
    schemas: [keys.map((key, i) => ({ name: `${kind}_${i}`, type: 'text' as const, position: { x: 10, y: 10 + i * 12 }, width: 80, height: 10 }))],
    bindings: Object.fromEntries(keys.map((key, i) => [`${kind}_${i}`, { op: 'text@1' as const, ui: 'text' as const, ref: { key } }])),
    pages: [{ no: 1, pdfIndex: 0, title: `${kind} 試験`, width: 210, height: 297 }],
    basePdfSha256: 'e'.repeat(64),
  }
}

before(async () => {
  if (!url) return
  const { createPool } = await import('../db/pool.ts')
  const admin = await createPool({ DATABASE_URL: url })
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  await admin.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema })
  const { migrate } = await import('../db/migrate.ts')
  await migrate(db)
  const { seed } = await import('../db/seed.ts')
  const mine = await seed(db, { email: 'careplan@example.com' })
  const other = await seed(db, { email: 'careplan-other@example.com', officeName: 'ほかの事業所' })
  clients = mine.clients

  // ケアプランの様式（第1表・第2表・第3表）。本物の PDF は PR3 で入れる
  const forms = await import('../db/forms.ts')
  await forms.registerVersion(db, planForm('care_plan_1', ['person.name', 'person.address', 'plan.intentionAnalysis', 'plan.overallPolicy']), { publish: true })
  await forms.registerVersion(db, planForm('care_plan_2', ['plan.needs']), { publish: true })
  await forms.registerVersion(db, planForm('care_plan_3', ['plan.weekly', 'plan.nonWeeklyServices']), { publish: true })

  // AI 原案の参照元にする、保存済みのアセスメント（山田さん）
  const rev = await db.query(
    `SELECT r.id, r.rev, r.document_id FROM revisions r JOIN documents d ON d.id = r.document_id
     WHERE d.client_id = $1 AND d.kind = 'assessment' ORDER BY r.rev DESC LIMIT 1`,
    [clients.yamada],
  )
  assessmentRevision = { id: Number(rev.rows[0].id), rev: Number(rev.rows[0].rev), documentId: rev.rows[0].document_id }

  const { createApiServer } = await import('../api/server.ts')
  const { DevVerifier } = await import('../api/auth.ts')
  const { LocalStorage } = await import('../api/storage.ts')
  storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-plan-api-')))
  const server = createApiServer({
    db: async () => db,
    verifier: () => new DevVerifier(),
    storage: () => storage,
    queue: () => ({ async enqueue() {}, async enqueueFormImport() {} }),
    carePlanAi: async () => async () => {
      aiCalls++
      if (aiMode === 'throw') throw new Error('AI が落ちました')
      if (aiMode === 'invalid') return { plan1: 'これはオブジェクトではない', needs: 'これも違う' }
      return aiProposal
    },
    devAuth: true,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = async () => {
    await new Promise<void>((r) => server.close(() => r()))
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await db.end()
  }
  // ほかの事業所だけの利用者を、このファイルの office で作れないことも確かめる（別の office の clientId は 404）
  assert.ok(other.clients.kai)
})

after(async () => close())

test('第3表は stable ID を保ち、時刻・重複・翌日の重なり・事業所境界を検証する', { skip }, async () => {
  let plan = await createPlan(clients.sato)
  const needs = await put(`/api/care-plans/${plan.id}/needs`, { baseVersion: plan.lockVersion, needs: needPayload() })
  plan = (needs.body as { plan: PlanBody }).plan
  const serviceId = plan.needs![0].shortGoals[0].services[0].id
  const path = `/api/care-plans/${plan.id}/schedule`
  const slot = { serviceId, scheduleType: 'weekly', weekday: 7, start: '23:00', end: '01:00', endsNextDay: true }
  assert.equal((await call(path, { method: 'PUT', token: OTHER, body: JSON.stringify({ baseVersion: plan.lockVersion, slots: [] }) })).status, 404)
  const result = await put(path, { baseVersion: plan.lockVersion, slots: [slot, { serviceId, scheduleType: 'other', note: '月2回' }] })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  const saved = (result.body as { plan: PlanBody }).plan
  const slots = saved.slots as { id: string }[]
  assert.equal(slots.length, 2)
  assert.equal((await put(path, { baseVersion: plan.lockVersion, slots: [] })).status, 409)
  for (const [candidate, reason] of [
    [[{ ...slot, start: '24:00' }], 'invalid_time'],
    [[{ ...slot, end: '23:00' }], 'invalid_time'],
    [[slot, slot], 'duplicate'],
    [[slot, { ...slot, weekday: 1, start: '00:30', end: '02:00', endsNextDay: false }], 'overlap'],
    [[{ serviceId, scheduleType: 'other', note: ' ' }], 'invalid_other'],
    [[{ ...slot, serviceId: '00000000-0000-4000-8000-000000000000' }], 'unknown_service'],
    [[{ ...slot, periodFrom: '2027-04-01', periodTo: '2026-04-01' }], 'period_order'],
  ] as const) {
    const invalid = await put(path, { baseVersion: saved.lockVersion, slots: candidate })
    assert.equal(invalid.status, 422, JSON.stringify(invalid.body))
    assert.ok((invalid.body as { problems: { reason: string }[] }).problems.some((p) => p.reason === reason), JSON.stringify(invalid.body))
  }
  const updated = await put(path, { baseVersion: saved.lockVersion, slots: [{ ...slot, id: slots[0].id, end: '02:00' }] })
  assert.equal(updated.status, 200, JSON.stringify(updated.body))
  assert.equal(((updated.body as { plan: PlanBody }).plan.slots as { id: string }[])[0].id, slots[0].id)
  const current = (updated.body as { plan: PlanBody }).plan
  // 接する枠、異なるサービス、適用期間が重ならない同時刻は許す。
  const valid = await put(path, { baseVersion: current.lockVersion, slots: [
    { ...slot, id: slots[0].id },
    { ...slot, weekday: 1, start: '01:00', end: '02:00', endsNextDay: false },
    { ...slot, serviceId: plan.needs![0].shortGoals[1].services[0].id },
    { ...slot, weekday: 2, periodFrom: '2026-04-01', periodTo: '2026-04-30' },
    { ...slot, weekday: 2, periodFrom: '2026-05-01', periodTo: '2026-05-31' },
  ] })
  assert.equal(valid.status, 200, JSON.stringify(valid.body))
  const copy = await createPlan(clients.sato, { copyFromPlanId: plan.id })
  assert.equal(copy.slots!.length, 5)
  assert.ok((copy.slots as { id: string }[]).every((s) => !(valid.body as { plan: PlanBody }).plan.slots!.some((old) => (old as { id: string }).id === s.id)))
})

test('確定には3表の保存が必要で、期間だけの変更も検出し、確定後は改定版で訂正する', { skip }, async () => {
  let plan = await createPlan(clients.sato)
  const confirm = () => post(`/api/care-plans/${plan.id}/confirm`, { baseVersion: plan.lockVersion })
  assert.equal((await post(`/api/care-plans/${plan.id}/confirm`, { baseVersion: plan.lockVersion }, '')).status, 401)
  assert.equal((await post(`/api/care-plans/${plan.id}/confirm`, { baseVersion: plan.lockVersion }, OTHER)).status, 404)
  assert.equal((await confirm()).status, 409)
  plan = ((await put(`/api/care-plans/${plan.id}/needs`, { baseVersion: plan.lockVersion, needs: needPayload() })).body as { plan: PlanBody }).plan
  plan = ((await savePlan(plan)).body as { plan: PlanBody }).plan
  const payload = plan.needs!
  payload[0].longGoal.periodTo = '2027-02-28'
  plan = ((await put(`/api/care-plans/${plan.id}/needs`, { baseVersion: plan.lockVersion, needs: payload })).body as { plan: PlanBody }).plan
  const unsaved = await confirm()
  assert.equal(unsaved.status, 409)
  assert.equal((unsaved.body as { error: string }).error, 'unsaved_changes')
  plan = ((await savePlan(plan)).body as { plan: PlanBody }).plan
  const edited = await patch(`/api/documents/${planDoc(plan, 1).documentId}/fields`, {
    changes: [{ key: 'plan.overallPolicy', value: '人が直した未保存の方針', base: null }],
  })
  assert.equal(edited.status, 200, JSON.stringify(edited.body))
  assert.equal((await confirm()).status, 409)
  plan = ((await savePlan(plan)).body as { plan: PlanBody }).plan
  const confirmed = await confirm()
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  const body = confirmed.body as { plan: PlanBody, confirmation: { id: string, snapshotSha256: string } }
  assert.equal(body.plan.status, 'confirmed')
  assert.match(body.confirmation.snapshotSha256, /^[a-f0-9]{64}$/)
  const row = (await db.query('SELECT snapshot FROM care_plan_confirmations WHERE id = $1', [body.confirmation.id])).rows[0]
  assert.equal(row.snapshot.schemaVersion, 1)
  assert.equal(row.snapshot.plan1['plan.overallPolicy'], '人が直した未保存の方針')
  assert.equal(row.snapshot.services[0].serviceId, plan.needs![0].shortGoals[0].services[0].id)
  assert.equal((await savePlan(body.plan)).status, 409)
  assert.equal((await confirm()).status, 409)
  assert.equal((await patch(`/api/documents/${planDoc(plan, 1).documentId}/fields`, {
    changes: [{ key: 'plan.overallPolicy', base: '人が直した未保存の方針', value: '確定後の変更' }],
  })).status, 409)
  assert.equal((await put(`/api/care-plans/${plan.id}/schedule`, { baseVersion: body.plan.lockVersion, slots: [] })).status, 409)
  const next = await createPlan(clients.sato, { copyFromPlanId: plan.id })
  plan = ((await savePlan(next)).body as { plan: PlanBody }).plan
  assert.equal((await confirm()).status, 200)
  assert.equal((await getPlan(body.plan.id)).status, 'superseded')
})

test('計画版の作成・読み取りは事業所で絞られ、401・404 を返す', { skip }, async () => {
  assert.equal((await post(`/api/clients/${clients.sato}/care-plans`, { effectiveFrom: '2026-04-01' }, '')).status, 401)
  assert.equal((await post(`/api/clients/${clients.sato}/care-plans`, { effectiveFrom: '2026-04-01' }, OTHER)).status, 404)
  assert.equal((await call(`/api/clients/${clients.sato}/care-plans`, { token: OTHER })).status, 404)

  const plan = await createPlan(clients.sato)
  assert.equal(plan.status, 'draft')
  assert.equal(plan.version, 1)
  assert.equal(plan.effectiveFrom, '2026-04-01')
  assert.equal(plan.effectiveTo, '2027-03-31')
  assert.equal(plan.lockVersion, 1)
  assert.equal(plan.hasUnsavedChanges, true)
  assert.deepEqual(plan.documents.map((d) => d.formNo), [1, 2, 3])
  assert.deepEqual(plan.documents.map((d) => d.latestRevision), [0, 0, 0])
  assert.deepEqual(plan.needs, [])
  assert.equal(plan.plan1?.['person.name'], '佐藤 一郎', '第1表はアセスメントの同じ key を写す')

  assert.equal((await call(`/api/care-plans/${plan.id}`, { token: OTHER })).status, 404)
  assert.equal((await call('/api/care-plans/not-a-uuid')).status, 404)
  const listed = await call(`/api/clients/${clients.sato}/care-plans`)
  assert.equal(listed.status, 200)
  assert.equal((listed.body as { plans: PlanBody[] }).plans[0].id, plan.id)
})

test('AIの参照元選択に保存版の番号・日時だけを返し、事業所外には漏らさない', { skip }, async () => {
  const path = `/api/documents/${assessmentRevision.documentId}/revisions`
  assert.equal((await call(path, { token: '' })).status, 401)
  assert.equal((await call(path, { token: OTHER })).status, 404)
  const result = await call(path)
  assert.equal(result.status, 200)
  const revisions = (result.body as { revisions: { id: number, rev: number, savedAt: string }[] }).revisions
  assert.ok(revisions.some((r) => r.id === assessmentRevision.id))
  assert.ok(revisions.every((r) => Object.keys(r).sort().join(',') === 'id,rev,savedAt'))
})

test('計画版のPDFは未保存を409、元様式なしを503、事業所外を404にする', { skip }, async () => {
  let plan = await createPlan(clients.sato)
  const path = `/api/care-plans/${plan.id}/pdf?form=all`
  assert.equal((await call(path, { token: '' })).status, 401)
  assert.equal((await call(path, { token: OTHER })).status, 404)
  assert.equal((await call(path)).status, 409)
  plan = ((await savePlan(plan)).body as { plan: PlanBody }).plan
  const unavailable = await call(path)
  assert.equal(unavailable.status, 503, JSON.stringify(unavailable.body))
  assert.equal((unavailable.body as { error: string }).error, 'form_unavailable')
  assert.equal((await call(`/api/care-plans/${plan.id}/pdf?form=4`)).status, 400)
})

test('計画版が違えば書類も seq も混ざらず、第1表は作成後にアセスメントを直しても変わらない', { skip }, async () => {
  const first = await createPlan(clients.yamada)
  const second = await createPlan(clients.yamada)
  assert.notEqual(first.id, second.id)
  assert.notEqual(planDoc(first, 1).documentId, planDoc(second, 1).documentId)

  const seqs = await db.query('SELECT seq FROM documents WHERE id = ANY($1::uuid[]) ORDER BY seq', [[planDoc(first, 1).documentId, planDoc(second, 1).documentId]])
  assert.deepEqual(seqs.rows.map((r) => Number(r.seq)), [1, 2], '計画版が違えば documents.seq は進む')

  // アセスメントの住所を直しても、写した第1表は変わらない（自動同期しない）
  const before = (await getPlan(first.id)).plan1?.['person.address']
  assert.ok(before)
  const a = await patch(`/api/documents/${assessmentRevision.documentId}/fields`, {
    changes: [{ key: 'person.address', value: '見本県別の町 9-9-9', base: before }],
  })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  assert.equal((await getPlan(first.id)).plan1?.['person.address'], before)
  const doc1 = await call(`/api/documents/${planDoc(first, 1).documentId}`)
  assert.equal((doc1.body as { document: { fields: Record<string, { value: unknown }> } }).document.fields['person.address']?.value, before)
})

test('第2表は stable ID のまま並べ替えられ、baseVersion と期間の誤りを 409・422 で返す', { skip }, async () => {
  const plan = await createPlan(clients.sato)
  const first = await put(`/api/care-plans/${plan.id}/needs`, { baseVersion: plan.lockVersion, needs: needPayload() })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const after = (first.body as { plan: PlanBody }).plan
  assert.equal(after.lockVersion, 2)
  const need = after.needs![0]
  assert.ok(need.id)
  assert.ok(need.longGoal.id)
  assert.equal(need.shortGoals.length, 2)
  assert.ok(need.shortGoals[0].services[0].id)

  // 同じ ID のまま、短期目標とサービスを入れ替える
  const reversed = structuredClone(after.needs!)
  reversed[0].shortGoals.reverse()
  reversed[0].shortGoals[0].services.reverse()
  const second = await put(`/api/care-plans/${plan.id}/needs`, { baseVersion: after.lockVersion, needs: reversed })
  assert.equal(second.status, 200, JSON.stringify(second.body))
  const reordered = (second.body as { plan: PlanBody }).plan
  assert.deepEqual(reordered.needs![0].shortGoals.map((g) => g.id), [need.shortGoals[1].id, need.shortGoals[0].id])
  assert.equal(reordered.needs![0].id, need.id, '並べ替えてもニーズの ID は変わらない')

  // 古い baseVersion は 409
  const stale = await put(`/api/care-plans/${plan.id}/needs`, { baseVersion: after.lockVersion, needs: needPayload('（古い）') })
  assert.equal(stale.status, 409)
  assert.equal((stale.body as { error: string }).error, 'conflict')

  // ほかの計画版の ID は 422
  const other = await createPlan(clients.sato)
  const otherNeed = await put(`/api/care-plans/${other.id}/needs`, { baseVersion: other.lockVersion, needs: needPayload('（別）') })
  const foreign = (otherNeed.body as { plan: PlanBody }).plan.needs![0]
  const unknown = await put(`/api/care-plans/${plan.id}/needs`, { baseVersion: reordered.lockVersion, needs: [{ ...needPayload()[0], id: foreign.id }] })
  assert.equal(unknown.status, 422)
  assert.equal((unknown.body as { error: string }).error, 'validation_failed')

  // 期間の前後が逆は 422
  const bad = structuredClone(reordered.needs!)
  bad[0].longGoal.periodFrom = '2027-04-01'
  bad[0].longGoal.periodTo = '2026-04-01'
  const badPeriod = await put(`/api/care-plans/${plan.id}/needs`, { baseVersion: reordered.lockVersion, needs: bad })
  assert.equal(badPeriod.status, 422)
})

test('保存は3表の版を一度に作り、第2表の射影は汎用の欄の直しから守る', { skip }, async () => {
  const plan = await createPlan(clients.sato)
  const withNeeds = (await put(`/api/care-plans/${plan.id}/needs`, { baseVersion: plan.lockVersion, needs: needPayload() })).body as { plan: PlanBody }
  assert.equal(withNeeds.plan.lockVersion, 2)

  const saved = await post(`/api/care-plans/${plan.id}/save`, { baseVersion: withNeeds.plan.lockVersion })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const body = saved.body as { plan: PlanBody, revisions: { formNo: number, rev: number }[] }
  assert.deepEqual(body.revisions.map((r) => r.formNo), [1, 2, 3])
  assert.ok(body.revisions.every((r) => r.rev === 1))
  assert.equal(body.plan.lockVersion, 3)
  assert.equal(body.plan.hasUnsavedChanges, false)

  // 古い baseVersion の保存は 409
  const staleSave = await post(`/api/care-plans/${plan.id}/save`, { baseVersion: withNeeds.plan.lockVersion })
  assert.equal(staleSave.status, 409)
  assert.equal((staleSave.body as { error: string }).error, 'conflict')

  // 第2表の射影が保存されている
  const doc2 = await call(`/api/documents/${planDoc(body.plan, 2).documentId}`)
  const projected = (doc2.body as { document: { fields: Record<string, { value: { need: string, longGoal: string, shortGoals: { goal: string, services: { content: string }[] }[] }[] }> } }).document.fields['plan.needs'].value[0]
  assert.equal(projected.need, '入浴が一人でできない')
  assert.equal(projected.longGoal, '安全に入浴できる')
  assert.deepEqual(projected.shortGoals.map((g) => g.goal), ['手すりを使って浴槽をまたげる', '浴室の温度を自分で確かめる'])
  assert.equal(projected.shortGoals[0].services[0].content, '入浴介助')

  // 第2表の射影は汎用の欄の直し・保存では変えられない
  const genericPatch = await patch(`/api/documents/${planDoc(body.plan, 2).documentId}/fields`, {
    changes: [{ key: 'plan.needs', value: [], base: projected }],
  })
  assert.equal(genericPatch.status, 409)
  assert.equal((genericPatch.body as { error: string }).error, 'use_plan_api')
  const genericSave = await post(`/api/documents/${planDoc(body.plan, 2).documentId}/save`, { scope: 'document' })
  assert.equal(genericSave.status, 409)
  assert.equal((genericSave.body as { error: string }).error, 'use_plan_api')
  const genericEdits = await post(`/api/documents/${planDoc(body.plan, 2).documentId}/edits`, {
    formVersionId: planDoc(body.plan, 2).formVersionId,
    edits: [{ slot: 'care_plan_2_0', text: '印字欄から直す' }],
  })
  assert.equal(genericEdits.status, 409)
  assert.equal((genericEdits.body as { error: string }).error, 'use_plan_api')

  // 第1表は今までどおり直して保存できる
  const p = await patch(`/api/documents/${planDoc(body.plan, 1).documentId}/fields`, {
    changes: [{ key: 'plan.intentionAnalysis', value: '本人は家で暮らし続けたい', base: null }],
  })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  const resaved = await post(`/api/care-plans/${plan.id}/save`, { baseVersion: body.plan.lockVersion })
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body))
  const resavedBody = resaved.body as { revisions: { formNo: number, rev: number }[] }
  assert.equal(resavedBody.revisions.find((r) => r.formNo === 1)?.rev, 2)
  assert.equal((await getPlan(plan.id)).plan1?.['plan.intentionAnalysis'], '本人は家で暮らし続けたい')
})

test('AI 原案は保存済みアセスメントの版を固定し、人の値を上書きせず、失敗しても手入力を止めない', { skip }, async () => {
  const plan = await createPlan(clients.yamada)
  // 人が先に書いた欄は上書きしない
  const human = await patch(`/api/documents/${planDoc(plan, 1).documentId}/fields`, {
    changes: [{ key: 'plan.overallPolicy', value: '人は自宅で過ごすことを望んでいる', base: null }],
  })
  assert.equal(human.status, 200, JSON.stringify(human.body))

  aiMode = 'ok'
  aiProposal = {
    plan1: {
      'plan.intentionAnalysis': 'AI の意向分析',
      'plan.overallPolicy': 'AI の方針（人の値を上書きしてはいけない）',
    },
    needs: [{
      need: 'AI が見つけたニーズ',
      longGoal: { goal: 'AI の長期目標', periodText: '2026年4月〜2027年3月' },
      shortGoals: [{ goal: 'AI の短期目標', services: [{ content: '訪問介護', insured: true, kind: '訪問介護', frequency: '週1回' }] }],
    }],
    conflicts: [],
  }
  aiCalls = 0
  const made = await post(`/api/care-plans/${plan.id}/ai-drafts`, { sourceDocumentId: assessmentRevision.documentId, sourceRevisionId: assessmentRevision.id })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const draft = (made.body as DraftBody).draft
  assert.equal(draft.status, 'proposed')
  assert.equal(draft.sourceDocumentId, assessmentRevision.documentId)
  assert.equal(draft.sourceRevisionId, assessmentRevision.id)
  assert.equal(draft.sourceRevisionRev, assessmentRevision.rev)
  assert.equal(aiCalls, 1)
  const draftPath = `/api/care-plans/${plan.id}/ai-drafts/${draft.id}`
  assert.equal((await call(draftPath, { token: '' })).status, 401)
  assert.equal((await call(draftPath, { token: OTHER })).status, 404)
  const resumed = await call(draftPath)
  assert.equal(resumed.status, 200)
  assert.deepEqual((resumed.body as DraftBody).draft, draft)
  assert.equal(aiCalls, 1, '原案の再開では再生成しない')
  assert.equal((await call(`/api/care-plans/${randomUUID()}/ai-drafts/${draft.id}`)).status, 404)

  const applied = await post(`/api/care-plans/${plan.id}/ai-drafts/${draft.id}/apply`, { baseVersion: plan.lockVersion })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  const after = (applied.body as { plan: PlanBody, applied: { skipped: { target: string, reason: string }[] } })
  assert.equal(after.plan.plan1?.['plan.intentionAnalysis'], 'AI の意向分析')
  assert.equal(after.plan.plan1?.['plan.overallPolicy'], '人は自宅で過ごすことを望んでいる')
  assert.ok(after.applied.skipped.some((s) => s.target === 'plan.overallPolicy' && s.reason === 'human_value'))
  assert.equal(after.plan.needs?.length, 1)
  assert.equal(after.plan.needs?.[0].need, 'AI が見つけたニーズ')

  // もう一度適用しても、同じニーズは増えない
  const again = await post(`/api/care-plans/${plan.id}/ai-drafts/${draft.id}/apply`, { baseVersion: after.plan.lockVersion })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal((again.body as { plan: PlanBody }).plan.needs?.length, 1)

  // アセスメントを更新しても、前の原案の参照元は変わらない
  const nextRev = await db.query(
    `INSERT INTO revisions (office_id, document_id, rev, scope, "values", template_version_id, saved_by)
     SELECT d.office_id, d.id,
       coalesce((SELECT max(rev) FROM revisions WHERE document_id = d.id), 0) + 1, 'document',
       coalesce((SELECT "values" FROM revisions WHERE document_id = d.id ORDER BY rev DESC LIMIT 1), '{}'::jsonb),
       d.template_version_id, d.created_by
     FROM documents d WHERE d.id = $1 RETURNING id, rev`,
    [assessmentRevision.documentId],
  )
  const oldDraft = await db.query('SELECT source_revision_id, proposal FROM care_plan_ai_drafts WHERE id = $1', [draft.id])
  assert.equal(Number(oldDraft.rows[0].source_revision_id), assessmentRevision.id)
  assert.deepEqual((oldDraft.rows[0].proposal as { plan1: Record<string, unknown> }).plan1['plan.intentionAnalysis'], 'AI の意向分析')
  const newer = await post(`/api/care-plans/${plan.id}/ai-drafts`, { sourceDocumentId: assessmentRevision.documentId, sourceRevisionId: Number(nextRev.rows[0].id) })
  assert.equal(newer.status, 201, JSON.stringify(newer.body))
  assert.equal((newer.body as DraftBody).draft.sourceRevisionRev, Number(nextRev.rows[0].rev))

  // AI が失敗しても 201 で failed を返し、手入力は続けられる
  aiMode = 'throw'
  const failed = await post(`/api/care-plans/${plan.id}/ai-drafts`, { sourceDocumentId: assessmentRevision.documentId, sourceRevisionId: assessmentRevision.id })
  assert.equal(failed.status, 201, JSON.stringify(failed.body))
  assert.equal((failed.body as DraftBody).draft.status, 'failed')
  assert.equal((failed.body as DraftBody).draft.errorKind, 'ai_failed')
  const manual = await put(`/api/care-plans/${plan.id}/needs`, { baseVersion: (await getPlan(plan.id)).lockVersion, needs: needPayload('（手入力）') })
  assert.equal(manual.status, 200, JSON.stringify(manual.body))

  // 不正な JSON も failed
  aiMode = 'invalid'
  const invalid = await post(`/api/care-plans/${plan.id}/ai-drafts`, { sourceDocumentId: assessmentRevision.documentId, sourceRevisionId: assessmentRevision.id })
  assert.equal(invalid.status, 201, JSON.stringify(invalid.body))
  assert.equal((invalid.body as DraftBody).draft.status, 'failed')
  assert.equal((invalid.body as DraftBody).draft.errorKind, 'invalid_json')
})

test('前の計画版からは新しい ID で写し、版番号と series を引き継ぐ', { skip }, async () => {
  const first = await createPlan(clients.tanaka)
  const withNeeds = (await put(`/api/care-plans/${first.id}/needs`, { baseVersion: first.lockVersion, needs: needPayload() })).body as { plan: PlanBody }
  const saved = await post(`/api/care-plans/${first.id}/save`, { baseVersion: withNeeds.plan.lockVersion })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const firstPlan = (saved.body as { plan: PlanBody }).plan

  const copy = await createPlan(clients.tanaka, { copyFromPlanId: first.id, effectiveFrom: '2027-04-01', effectiveTo: null })
  assert.equal(copy.version, 2)
  assert.equal(copy.planSeriesId, firstPlan.planSeriesId)
  assert.equal(copy.previousPlanId, first.id)
  assert.notEqual(planDoc(copy, 1).documentId, planDoc(firstPlan, 1).documentId)
  assert.equal(copy.needs?.[0].need, firstPlan.needs?.[0].need)
  assert.notEqual(copy.needs?.[0].id, firstPlan.needs?.[0].id, '改定版は新しい stable ID')
  assert.notEqual(copy.needs?.[0].shortGoals[0].services[0].id, firstPlan.needs?.[0].shortGoals[0].services[0].id)
  assert.equal(copy.plan1?.['plan.intentionAnalysis'], firstPlan.plan1?.['plan.intentionAnalysis'], '第1表の値も写す')
})

test('PDFは第1→2→3表の保存値だけを出し、確定後も再現し、長文を422にする', { skip }, async () => {
  const { PDFDocument } = await import('@pdfme/pdf-lib')
  const { createHash } = await import('node:crypto')
  const { readSeed } = await import('../forms/admin/files.ts')
  const { registerVersion, readVersion, basePdfPath } = await import('../db/forms.ts')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // テストは公式PDFや通信に依存しない。公式と同じ座標のbindingsを合成PDFに印字する。
  const blank = await PDFDocument.create({ updateMetadata: false })
  blank.addPage([841.89, 595.276]).drawText('SYNTHETIC FORM', { x: 10, y: 580, size: 6 })
  const bytes = await blank.save()
  const sha = createHash('sha256').update(bytes).digest('hex')
  for (const no of [1, 2, 3]) {
    const version = await registerVersion(db, { ...readSeed(`care_plan_${no}`), basePdfSha256: sha }, { publish: true })
    await storage.writeOnce('forms', basePdfPath(await readVersion(db, version.versionId)), bytes, 'application/pdf')
  }
  let plan = await createPlan(clients.sato)
  for (const no of [2, 3] as const) {
    const doc = await call(`/api/documents/${planDoc(plan, no).documentId}`)
    assert.equal((doc.body as { document: { fields: Record<string, { value: string }> } }).document.fields['person.name'].value, plan.plan1!['person.name'])
  }
  plan = ((await put(`/api/care-plans/${plan.id}/needs`, { baseVersion: plan.lockVersion, needs: needPayload() })).body as { plan: PlanBody }).plan
  plan = ((await savePlan(plan)).body as { plan: PlanBody }).plan
  assert.equal((await patch(`/api/documents/${planDoc(plan, 1).documentId}/fields`, {
    changes: [{ key: 'plan.overallPolicy', base: null, value: '未保存の方針' }],
  })).status, 200)
  const all = await call(`/api/care-plans/${plan.id}/pdf?form=all`)
  assert.equal(all.status, 200, JSON.stringify(all.body))
  const loading = getDocument({
    data: new Uint8Array(all.body as ArrayBuffer),
    standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)),
  })
  const pdf = await loading.promise
  assert.equal(pdf.numPages, 3)
  const texts: string[] = []
  for (let no = 1; no <= 3; no++) texts.push((await (await pdf.getPage(no)).getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(''))
  assert.ok(!texts.join('').includes('未保存の方針'))
  assert.ok(texts[1].includes('入浴介助'))
  assert.ok(!texts[0].includes('入浴介助'))
  await loading.destroy()
  // 第1表の初期コピーを後から直しても、別書類へ自動同期しない。
  const renamed = await patch(`/api/documents/${planDoc(plan, 1).documentId}/fields`, {
    changes: [{ key: 'person.name', base: plan.plan1!['person.name'], value: '見本 改定名' }],
  })
  assert.equal(renamed.status, 200)
  const independent = await call(`/api/documents/${planDoc(plan, 2).documentId}`)
  assert.notEqual((independent.body as { document: { fields: Record<string, { value: string }> } }).document.fields['person.name'].value, '見本 改定名')
  assert.equal((await patch(`/api/documents/${planDoc(plan, 3).documentId}/fields`, {
    changes: [{ key: 'plan.createdDate', base: null, value: '2026-04-01' }],
  })).status, 200)
  assert.equal((await getPlan(plan.id)).hasUnsavedChanges, true, '第3表の独立した入力欄も未保存として返す')
  plan = ((await savePlan(plan)).body as { plan: PlanBody }).plan
  assert.equal(plan.hasUnsavedChanges, false)
  assert.equal((await post(`/api/care-plans/${plan.id}/confirm`, { baseVersion: plan.lockVersion })).status, 200)
  assert.equal((await call(`/api/care-plans/${plan.id}/pdf?form=2`)).status, 200)
  const audit = await db.query("SELECT detail FROM audit_events WHERE action = 'care_plan.pdf' AND detail->>'planId' = $1", [plan.id])
  assert.equal(audit.rows.length, 2)
  assert.ok(!JSON.stringify(audit.rows).includes('入浴介助'))

  const long = await createPlan(clients.sato)
  assert.equal((await patch(`/api/documents/${planDoc(long, 1).documentId}/fields`, {
    changes: [{ key: 'plan.overallPolicy', base: null, value: '長すぎる文章'.repeat(1000) }],
  })).status, 200)
  assert.equal((await savePlan(long)).status, 200)
  const overflow = await call(`/api/care-plans/${long.id}/pdf?form=1`)
  assert.equal(overflow.status, 422, JSON.stringify(overflow.body))
  assert.equal((overflow.body as { error: string }).error, 'overflow')
})
