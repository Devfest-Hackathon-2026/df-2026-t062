import { AiPlanSlotSchema } from '../core/care-plan-slot.ts'
// ケアプラン（#90）の読み書き。計画版・第1〜3表の書類・第2表のニーズ/目標/サービス・AI 原案。
// 仕様: docs/ケアプラン仕様.md。値そのものは documents ごとの field_values に持ち、計画版の表は stable ID を持つ。
import { createHash, randomUUID } from 'node:crypto'
import { validValue } from '../core/schema.ts'
import { loadFormDef } from './forms.ts'
import { tx, type Db, type Tx } from './pool.ts'
import {
  audit, BadRequest, Conflict, createDocumentInTx, NotFound, readFields, saveDocumentInTx, writeField, type Staff,
} from './repo.ts'

type Q = Db | Tx

export type CarePlanStatus = 'draft' | 'confirmed' | 'superseded'

/** 計画版の構造・時刻の決まりに反する（422）。problems に場所と理由を返す */
export class PlanValidationFailed extends Error {
  problems: { path: string, reason: string }[]
  constructor(problems: { path: string, reason: string }[]) {
    super('ケアプランの入力が決まりに合いません')
    this.problems = problems
  }
}
/** 確定済み・置き換え済みの計画版を変えようとした（409） */
export class PlanNotDraft extends Error {}
/** 保存していない変更がある（409） */
export class PlanUnsavedChanges extends Error {}
/** 第2表・第3表の射影を、汎用の欄の直しで変えようとした（409） */
export class UsePlanApi extends Error {}

export interface CarePlanDocumentView {
  formNo: 1 | 2 | 3
  documentId: string
  formVersionId: string
  /** 保存済みの最新の版番号（まだ保存していなければ 0） */
  latestRevision: number
  savedAt: string | null
}

export interface ServiceView {
  id: string
  content: string
  insured: boolean
  kind: string | null
  provider: string | null
  frequency: string | null
  periodText: string | null
  periodFrom: string | null
  periodTo: string | null
}

export interface ShortGoalView {
  id: string
  goal: string
  periodText: string | null
  periodFrom: string | null
  periodTo: string | null
  services: ServiceView[]
}

export interface LongGoalView {
  id: string
  goal: string
  periodText: string | null
  periodFrom: string | null
  periodTo: string | null
}

export interface NeedView {
  id: string
  need: string
  longGoal: LongGoalView
  shortGoals: ShortGoalView[]
}

export interface SlotView {
  id: string
  serviceId: string
  scheduleType: 'weekly' | 'other'
  weekday: number | null
  start: string | null
  end: string | null
  endsNextDay: boolean
  note: string | null
  periodFrom: string | null
  periodTo: string | null
}

export interface SlotInput {
  id?: string
  serviceId: string
  scheduleType: 'weekly' | 'other'
  weekday?: number | null
  start?: string | null
  end?: string | null
  endsNextDay?: boolean
  note?: string | null
  periodFrom?: string | null
  periodTo?: string | null
}

function validatedSlots(view: CarePlanView, input: SlotInput[]): SlotView[] {
  if (input.length > 500) throw new PlanValidationFailed([{ path: 'slots', reason: 'too_many' }])
  const services = new Map(view.needs.flatMap((n) => n.shortGoals.flatMap((g) => g.services.map((s) => [s.id, s] as const))))
  const serviceIds = new Set(services.keys())
  const existingIds = new Set(view.slots.map((s) => s.id))
  const seenIds = new Set<string>()
  const problems: { path: string, reason: string }[] = []
  const slots: SlotView[] = input.map((s, i) => {
    const path = `slots.${i}`
    if (!serviceIds.has(s.serviceId)) problems.push({ path, reason: 'unknown_service' })
    if (s.id && (!existingIds.has(s.id) || seenIds.has(s.id))) problems.push({ path, reason: 'unknown_id' })
    if (s.id) seenIds.add(s.id)
    if (s.periodFrom && s.periodTo && s.periodTo < s.periodFrom) problems.push({ path, reason: 'period_order' })
    const slot: SlotView = {
      ...s, id: s.id ?? randomUUID(), weekday: s.weekday ?? null, start: s.start ?? null, end: s.end ?? null,
      endsNextDay: s.endsNextDay ?? false, note: s.note?.trim() || null,
      periodFrom: s.periodFrom ?? null, periodTo: s.periodTo ?? null,
    }
    if (slot.scheduleType === 'other') {
      if (slot.weekday !== null || slot.start !== null || slot.end !== null || slot.endsNextDay || !slot.note) problems.push({ path, reason: 'invalid_other' })
    } else {
      const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/
      if (!slot.weekday || slot.weekday < 1 || slot.weekday > 7 ||
          !slot.start || !slot.end || !time.test(slot.start) || !time.test(slot.end) ||
          (slot.endsNextDay ? slot.end >= slot.start : slot.end <= slot.start)) problems.push({ path, reason: 'invalid_time' })
    }
    return slot
  })
  if (problems.length) throw new PlanValidationFailed(problems)
  const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i]
    if (a.scheduleType !== 'weekly') continue
    const startA = (a.weekday! - 1) * 1440 + minutes(a.start!)
    const endA = (a.weekday! - 1) * 1440 + minutes(a.end!) + (a.endsNextDay ? 1440 : 0)
    for (const b of slots.slice(0, i)) {
      if (b.scheduleType !== 'weekly' || a.serviceId !== b.serviceId) continue
      const duplicate = a.weekday === b.weekday && a.start === b.start && a.end === b.end && a.endsNextDay === b.endsNextDay &&
        a.periodFrom === b.periodFrom && a.periodTo === b.periodTo
      const service = services.get(a.serviceId)!
      const fromA = a.periodFrom ?? service.periodFrom ?? view.effectiveFrom
      const fromB = b.periodFrom ?? service.periodFrom ?? view.effectiveFrom
      const toA = a.periodTo ?? service.periodTo ?? view.effectiveTo ?? '9999-12-31'
      const toB = b.periodTo ?? service.periodTo ?? view.effectiveTo ?? '9999-12-31'
      const startB = (b.weekday! - 1) * 1440 + minutes(b.start!)
      const endB = (b.weekday! - 1) * 1440 + minutes(b.end!) + (b.endsNextDay ? 1440 : 0)
      const overlap = fromA <= toB && fromB <= toA &&
        [-10080, 0, 10080].some((offset) => startA < endB + offset && startB + offset < endA)
      if (duplicate || overlap) problems.push({ path: `slots.${i}`, reason: duplicate ? 'duplicate' : 'overlap' })
    }
  }
  if (problems.length) throw new PlanValidationFailed(problems)
  return slots
}

/** 時間軸は週初からの分。日曜の翌日部分は次の週の月曜とも比較する。 */
export async function saveCarePlanSchedule(db: Db, staff: Staff, planId: string, baseVersion: number, input: SlotInput[]) {
  return tx(db, async (c) => {
    const plan = await lockPlan(c, staff.officeId, planId)
    checkBase(plan, baseVersion)
    const view = await getCarePlan(c, staff.officeId, planId)
    const slots = validatedSlots(view, input)
    // 全体置換だが ID は維持する。時刻の入れ替え時にも一意制約に途中で触れない。
    await c.query('DELETE FROM care_plan_service_slots WHERE plan_id = $1', [planId])
    for (const [i, s] of slots.entries()) {
      await c.query(
        `INSERT INTO care_plan_service_slots
         (id, plan_id, service_id, schedule_type, weekday, start_time, end_time, ends_next_day, note, period_from, period_to, ordinal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [s.id, planId, s.serviceId, s.scheduleType, s.weekday, s.start, s.end, s.endsNextDay, s.note, s.periodFrom, s.periodTo, i + 1],
      )
    }
    await bumpPlan(c, planId)
    await audit(c, staff, staff.officeId, 'care_plan.schedule', { clientId: plan.clientId }, { planId, slots: slots.length })
    return getCarePlan(c, staff.officeId, planId)
  })
}

export interface CarePlanAiDraftView {
  id: string
  status: AiDraftDetail['status']
  referencedAt: string
  sourceRevisionId: number
}

export interface CarePlanView {
  id: string
  clientId: string
  planSeriesId: string
  version: number
  status: CarePlanStatus
  effectiveFrom: string
  effectiveTo: string | null
  previousPlanId: string | null
  lockVersion: number
  hasUnsavedChanges: boolean
  documents: CarePlanDocumentView[]
  /** 第1表の今の値（編集中の値。保存済みは revisions を見る） */
  plan1: Record<string, unknown>
  needs: NeedView[]
  slots: SlotView[]
  aiDraft: CarePlanAiDraftView | null
  confirmation: { id: string, confirmedAt: string, confirmedBy: string, snapshotSha256: string } | null
}

export interface CarePlanSummary {
  id: string
  version: number
  status: CarePlanStatus
  effectiveFrom: string
  effectiveTo: string | null
  updatedAt: string
  confirmedAt: string | null
}

export interface ServiceInput {
  id?: string
  content: string
  insured?: boolean
  kind?: string | null
  provider?: string | null
  frequency?: string | null
  periodText?: string | null
  periodFrom?: string | null
  periodTo?: string | null
}

export interface ShortGoalInput {
  id?: string
  goal: string
  periodText?: string | null
  periodFrom?: string | null
  periodTo?: string | null
  services?: ServiceInput[]
}

export interface NeedInput {
  id?: string
  need: string
  longGoal: {
    id?: string
    goal: string
    periodText?: string | null
    periodFrom?: string | null
    periodTo?: string | null
  }
  shortGoals?: ShortGoalInput[]
}

export interface AiDraftDetail {
  id: string
  planId: string
  status: 'proposed' | 'applied' | 'partially_applied' | 'rejected' | 'failed'
  sourceDocumentId: string
  sourceRevisionId: number
  sourceRevisionRev: number
  referencedAt: string
  proposal: unknown
  conflicts: unknown
  applied: unknown
  errorKind: string | null
}

export interface CarePlanDrafterInput {
  plan: CarePlanView
  clientName: string
  source: {
    documentId: string
    revisionId: number
    rev: number
    formVersionId: string
    savedAt: string
    values: Record<string, unknown>
  }
}
/** AI 原案を作る関数。テストでは偽物に差し替える。失敗は例外で知らせる */
export type CarePlanDrafter = (input: CarePlanDrafterInput) => Promise<unknown>

const PLAN_COLUMNS = 'id, office_id, client_id, plan_series_id, version, status, effective_from, effective_to, previous_plan_id, lock_version'

const date = (v: unknown): string => {
  if (v instanceof Date) {
    // date 列は pg がローカル時刻の Date にする。日付だけを返す
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  }
  return String(v).slice(0, 10)
}
const dateOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : date(v))
const time = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 5))
const iso = (v: unknown): string => new Date(v as Date | string).toISOString()
const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

function dayName(weekday: number): string {
  return ['月', '火', '水', '木', '金', '土', '日'][weekday - 1] ?? ''
}

function planRow(p: Record<string, unknown>) {
  return {
    id: p.id as string,
    officeId: p.office_id as string,
    clientId: p.client_id as string,
    planSeriesId: p.plan_series_id as string,
    version: Number(p.version),
    status: p.status as CarePlanStatus,
    effectiveFrom: date(p.effective_from),
    effectiveTo: dateOrNull(p.effective_to),
    previousPlanId: (p.previous_plan_id as string | null) ?? null,
    lockVersion: Number(p.lock_version),
  }
}

async function lockPlan(c: Tx, officeId: string, planId: string) {
  let p: Record<string, unknown> | undefined
  try {
    p = (await c.query(`SELECT ${PLAN_COLUMNS} FROM care_plans WHERE id = $1 AND office_id = $2 FOR UPDATE`, [planId, officeId])).rows[0]
  } catch (e) {
    if ((e as { code?: string }).code === '22P02') throw new NotFound(planId)
    throw e
  }
  if (!p) throw new NotFound(planId)
  const row = planRow(p)
  if (row.status !== 'draft') throw new PlanNotDraft()
  return row
}

function checkBase(plan: { lockVersion: number }, baseVersion: number) {
  if (plan.lockVersion !== baseVersion) throw new Conflict('care_plan')
}

/** 利用者がこの事業所のもので、アーカイブされていないこと（無ければ 404） */
async function lockClient(c: Tx, officeId: string, clientId: string) {
  let r: Record<string, unknown> | undefined
  try {
    r = (await c.query('SELECT id FROM clients WHERE id = $1 AND office_id = $2 AND archived_at IS NULL FOR UPDATE', [clientId, officeId])).rows[0]
  } catch (e) {
    if ((e as { code?: string }).code === '22P02') throw new NotFound(clientId)
    throw e
  }
  if (!r) throw new NotFound(clientId)
  return r.id as string
}

/** 計画版を1つ読む。ほかの事業所・存在しない ID は NotFound（404） */
export async function getCarePlan(db: Q, officeId: string, planId: string): Promise<CarePlanView> {
  let p: Record<string, unknown> | undefined
  try {
    p = (await db.query(`SELECT ${PLAN_COLUMNS}, saved_structure FROM care_plans WHERE id = $1 AND office_id = $2`, [planId, officeId])).rows[0]
  } catch (e) {
    // uuid の形でない ID も「無い」として扱う（存在を漏らさない）
    if ((e as { code?: string }).code === '22P02') throw new NotFound(planId)
    throw e
  }
  if (!p) throw new NotFound(planId)
  const plan = planRow(p)

  const docs = await db.query(
    `SELECT cpd.form_no, cpd.document_id, d.template_version_id, coalesce(r.rev, 0) AS latest_revision, r.saved_at, r."values" AS saved_values
     FROM care_plan_documents cpd
     JOIN documents d ON d.id = cpd.document_id
     LEFT JOIN LATERAL (
       SELECT rev, saved_at, "values" FROM revisions WHERE document_id = cpd.document_id ORDER BY rev DESC LIMIT 1
     ) r ON true
     WHERE cpd.plan_id = $1
     ORDER BY cpd.form_no`,
    [plan.id],
  )
  const plan1Fields = await db.query(
    `SELECT f.key, f.value, cpd.form_no FROM field_values f
     JOIN care_plan_documents cpd ON cpd.document_id = f.document_id
     WHERE cpd.plan_id = $1`,
    [plan.id],
  )
  const needs = await readNeeds(db, plan.id)
  const slots = await readSlots(db, plan.id)
  const drafts = await db.query(
    `SELECT id, status, referenced_at, source_revision_id
     FROM care_plan_ai_drafts WHERE plan_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [plan.id],
  )
  const confirmations = await db.query(
    'SELECT id, confirmed_at, confirmed_by, snapshot_sha256 FROM care_plan_confirmations WHERE plan_id = $1',
    [plan.id],
  )

  const draft = drafts.rows[0]
  const confirmation = confirmations.rows[0]
  return {
    id: plan.id,
    clientId: plan.clientId,
    planSeriesId: plan.planSeriesId,
    version: plan.version,
    status: plan.status,
    effectiveFrom: plan.effectiveFrom,
    effectiveTo: plan.effectiveTo,
    previousPlanId: plan.previousPlanId,
    lockVersion: plan.lockVersion,
    hasUnsavedChanges: !p.saved_structure || canonical(p.saved_structure) !== canonical({ needs, slots }) ||
      docs.rows.some((d) => canonical(d.saved_values ?? {}) !== canonical(Object.fromEntries(plan1Fields.rows.filter((f) => f.form_no === d.form_no).map((f) => [f.key as string, f.value])))),
    documents: docs.rows.map((d) => ({
      formNo: Number(d.form_no) as 1 | 2 | 3,
      documentId: d.document_id as string,
      formVersionId: d.template_version_id as string,
      latestRevision: Number(d.latest_revision),
      savedAt: d.saved_at ? iso(d.saved_at) : null,
    })),
    plan1: Object.fromEntries(plan1Fields.rows.filter((f) => Number(f.form_no) === 1).map((f) => [f.key as string, f.value])),
    needs,
    slots,
    aiDraft: draft ? {
      id: draft.id as string,
      status: draft.status as AiDraftDetail['status'],
      referencedAt: iso(draft.referenced_at),
      sourceRevisionId: Number(draft.source_revision_id),
    } : null,
    confirmation: confirmation ? {
      id: confirmation.id as string,
      confirmedAt: iso(confirmation.confirmed_at),
      confirmedBy: confirmation.confirmed_by as string,
      snapshotSha256: confirmation.snapshot_sha256 as string,
    } : null,
  }
}

interface StructureGoal {
  id: string
  needId: string
  level: 'long' | 'short'
  ordinal: number
  goal: string
  periodText: string | null
  periodFrom: string | null
  periodTo: string | null
}
interface StructureService extends ServiceView {
  needId: string
  shortGoalId: string
  ordinal: number
}
interface Structure {
  needs: { id: string, need: string, ordinal: number }[]
  goals: StructureGoal[]
  services: StructureService[]
}

async function readStructure(db: Q, planId: string): Promise<Structure> {
  const needs = await db.query('SELECT id, need_text, ordinal FROM care_plan_needs WHERE plan_id = $1 ORDER BY ordinal', [planId])
  const goals = await db.query('SELECT id, need_id, level, ordinal, goal_text, period_text, period_from, period_to FROM care_plan_goals WHERE plan_id = $1 ORDER BY ordinal', [planId])
  const services = await db.query(
    `SELECT id, need_id, short_goal_id, ordinal, content, insured, service_kind, provider, frequency_text, period_text, period_from, period_to
     FROM care_plan_services WHERE plan_id = $1 ORDER BY ordinal`,
    [planId],
  )
  return {
    needs: needs.rows.map((n) => ({ id: n.id as string, need: n.need_text as string, ordinal: Number(n.ordinal) })),
    goals: goals.rows.map((g) => ({
      id: g.id as string,
      needId: g.need_id as string,
      level: g.level as 'long' | 'short',
      ordinal: Number(g.ordinal),
      goal: g.goal_text as string,
      periodText: (g.period_text as string | null) ?? null,
      periodFrom: dateOrNull(g.period_from),
      periodTo: dateOrNull(g.period_to),
    })),
    services: services.rows.map((s) => ({
      id: s.id as string,
      needId: s.need_id as string,
      shortGoalId: s.short_goal_id as string,
      ordinal: Number(s.ordinal),
      content: s.content as string,
      insured: s.insured as boolean,
      kind: (s.service_kind as string | null) ?? null,
      provider: (s.provider as string | null) ?? null,
      frequency: (s.frequency_text as string | null) ?? null,
      periodText: (s.period_text as string | null) ?? null,
      periodFrom: dateOrNull(s.period_from),
      periodTo: dateOrNull(s.period_to),
    })),
  }
}

async function readNeeds(db: Q, planId: string): Promise<NeedView[]> {
  const s = await readStructure(db, planId)
  const shortByNeed = new Map<string, ShortGoalView[]>()
  const serviceByGoal = new Map<string, ServiceView[]>()
  for (const sv of s.services) {
    const list = serviceByGoal.get(sv.shortGoalId) ?? []
    list.push({
      id: sv.id, content: sv.content, insured: sv.insured, kind: sv.kind, provider: sv.provider,
      frequency: sv.frequency, periodText: sv.periodText, periodFrom: sv.periodFrom, periodTo: sv.periodTo,
    })
    serviceByGoal.set(sv.shortGoalId, list)
  }
  for (const g of s.goals) {
    if (g.level !== 'short') continue
    const list = shortByNeed.get(g.needId) ?? []
    list.push({
      id: g.id, goal: g.goal, periodText: g.periodText, periodFrom: g.periodFrom, periodTo: g.periodTo,
      services: serviceByGoal.get(g.id) ?? [],
    })
    shortByNeed.set(g.needId, list)
  }
  return s.needs.map((n) => {
    const long = s.goals.find((g) => g.needId === n.id && g.level === 'long')
    return {
      id: n.id,
      need: n.need,
      longGoal: long
        ? { id: long.id, goal: long.goal, periodText: long.periodText, periodFrom: long.periodFrom, periodTo: long.periodTo }
        : { id: '', goal: '', periodText: null, periodFrom: null, periodTo: null },
      shortGoals: shortByNeed.get(n.id) ?? [],
    }
  })
}

async function readSlots(db: Q, planId: string): Promise<SlotView[]> {
  const r = await db.query(
    `SELECT id, service_id, schedule_type, weekday, start_time, end_time, ends_next_day, note, period_from, period_to
     FROM care_plan_service_slots WHERE plan_id = $1 ORDER BY ordinal, id`,
    [planId],
  )
  return r.rows.map((s) => ({
    id: s.id as string,
    serviceId: s.service_id as string,
    scheduleType: s.schedule_type as 'weekly' | 'other',
    weekday: s.weekday === null ? null : Number(s.weekday),
    start: time(s.start_time),
    end: time(s.end_time),
    endsNextDay: s.ends_next_day as boolean,
    note: (s.note as string | null) ?? null,
    periodFrom: dateOrNull(s.period_from),
    periodTo: dateOrNull(s.period_to),
  }))
}

/** 利用者の計画版を新しい順に返す（一覧用） */
export async function listCarePlans(db: Q, officeId: string, clientId: string): Promise<CarePlanSummary[]> {
  const r = await db.query(
    `SELECT id, version, status, effective_from, effective_to, updated_at, confirmed_at
     FROM care_plans WHERE office_id = $1 AND client_id = $2
     ORDER BY created_at DESC, version DESC`,
    [officeId, clientId],
  )
  return r.rows.map((x) => ({
    id: x.id as string,
    version: Number(x.version),
    status: x.status as CarePlanStatus,
    effectiveFrom: date(x.effective_from),
    effectiveTo: dateOrNull(x.effective_to),
    updatedAt: iso(x.updated_at),
    confirmedAt: x.confirmed_at ? iso(x.confirmed_at) : null,
  }))
}

/** 利用者の存在を確かめてから計画版の一覧を返す（ほかの事業所は 404） */
export async function listClientCarePlans(db: Q, officeId: string, clientId: string): Promise<CarePlanSummary[]> {
  let c: Record<string, unknown> | undefined
  try {
    c = (await db.query('SELECT id FROM clients WHERE id = $1 AND office_id = $2 AND archived_at IS NULL', [clientId, officeId])).rows[0]
  } catch (e) {
    if ((e as { code?: string }).code === '22P02') throw new NotFound(clientId)
    throw e
  }
  if (!c) throw new NotFound(clientId)
  return listCarePlans(db, officeId, clientId)
}

export interface CreateCarePlanInput {
  effectiveFrom: string
  effectiveTo: string | null
  copyFromPlanId: string | null
}

/** 計画版を作る。3表の書類を同じトランザクションで作り、第1表はアセスメントから一度だけ写す */
export async function createCarePlan(db: Db, staff: Staff, clientId: string, input: CreateCarePlanInput): Promise<CarePlanView> {
  if (!isDate(input.effectiveFrom)) throw new BadRequest('適用開始日が不正です')
  if (input.effectiveTo !== null && !isDate(input.effectiveTo)) throw new BadRequest('適用終了日が不正です')
  if (input.effectiveTo !== null && input.effectiveTo < input.effectiveFrom) throw new BadRequest('適用終了日は適用開始日以降にしてください')
  if (input.copyFromPlanId !== null && !isUuid(input.copyFromPlanId)) throw new NotFound(input.copyFromPlanId)

  return tx(db, async (c) => {
    await lockClient(c, staff.officeId, clientId)

    let planSeriesId: string = randomUUID()
    let version = 1
    let previousPlanId: string | null = null
    let source: CarePlanView | null = null
    if (input.copyFromPlanId) {
      source = await getCarePlan(c, staff.officeId, input.copyFromPlanId)
      if (source.clientId !== clientId) throw new NotFound(input.copyFromPlanId)
      planSeriesId = source.planSeriesId
      previousPlanId = source.id
      version = Number((await c.query(
        'SELECT coalesce(max(version), 0) + 1 AS v FROM care_plans WHERE client_id = $1 AND plan_series_id = $2',
        [clientId, planSeriesId],
      )).rows[0].v)
    }

    const plan = (await c.query(
      `INSERT INTO care_plans (office_id, client_id, plan_series_id, version, effective_from, effective_to, previous_plan_id, created_by, lock_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1) RETURNING id`,
      [staff.officeId, clientId, planSeriesId, version, input.effectiveFrom, input.effectiveTo, previousPlanId, staff.id],
    )).rows[0]

    const docIds: Record<1 | 2 | 3, string> = { 1: '', 2: '', 3: '' }
    for (const formNo of [1, 2, 3] as const) {
      const doc = await createDocumentInTx(c, staff, clientId, `care_plan_${formNo}`)
      docIds[formNo] = doc.id
      await c.query('INSERT INTO care_plan_documents (plan_id, form_no, document_id) VALUES ($1,$2,$3)', [plan.id, formNo, doc.id])
    }

    if (source) {
      // 各表の独立した値をそれぞれ写す。第2/3表の射影は次の保存で構造から作る。
      for (const sourceDoc of source.documents) {
        const target = (await c.query('SELECT template_version_id FROM documents WHERE id = $1', [docIds[sourceDoc.formNo]])).rows[0]
        const allowed = new Set((await loadFormDef(c, target.template_version_id)).keys)
        for (const [key, f] of Object.entries(await readFields(c, sourceDoc.documentId))) {
          if (allowed.has(key) && !['plan.needs', 'plan.weekly', 'plan.nonWeeklyServices'].includes(key)) {
            await writeField(c, staff.officeId, clientId, docIds[sourceDoc.formNo], key, f.value, 'cm', staff.id)
          }
        }
      }
      await copyStructure(c, source, plan.id as string)
    } else {
      // 作成時だけの初期コピー。以後はどの表の値も自動同期しない。
      const firstFields = await readFields(c, docIds[1])
      const assessment = (await c.query(
        "SELECT id FROM documents WHERE client_id = $1 AND office_id = $2 AND kind = 'assessment' ORDER BY seq DESC LIMIT 1",
        [clientId, staff.officeId],
      )).rows[0]
      const assessmentFields = assessment ? await readFields(c, assessment.id) : {}
      for (const formNo of [2, 3] as const) {
        const target = (await c.query('SELECT template_version_id FROM documents WHERE id = $1', [docIds[formNo]])).rows[0]
        const allowed = new Set((await loadFormDef(c, target.template_version_id)).keys)
        for (const key of ['person.name', 'plan.createdDate', 'dailySchedule']) {
          const field = firstFields[key] ?? assessmentFields[key]
          if (field && allowed.has(key)) await writeField(c, staff.officeId, clientId, docIds[formNo], key, field.value, 'cm', staff.id)
        }
      }
    }

    await audit(c, staff, staff.officeId, 'care_plan.create', { clientId, documentId: docIds[1] }, {
      planId: plan.id, version, copiedFrom: previousPlanId,
    })
    return getCarePlan(c, staff.officeId, plan.id as string)
  })
}

async function copyStructure(c: Tx, source: CarePlanView, targetPlanId: string) {
  const needIds = new Map<string, string>()
  const goalIds = new Map<string, string>()
  const serviceIds = new Map<string, string>()
  for (let i = 0; i < source.needs.length; i++) {
    const n = source.needs[i]
    const needId = randomUUID()
    needIds.set(n.id, needId)
    await c.query(
      'INSERT INTO care_plan_needs (id, plan_id, ordinal, need_text) VALUES ($1,$2,$3,$4)',
      [needId, targetPlanId, i + 1, n.need],
    )
    const longId = randomUUID()
    goalIds.set(n.longGoal.id, longId)
    await insertGoal(c, targetPlanId, longId, needId, 'long', 1, n.longGoal)
    for (let j = 0; j < n.shortGoals.length; j++) {
      const g = n.shortGoals[j]
      const goalId = randomUUID()
      goalIds.set(g.id, goalId)
      await insertGoal(c, targetPlanId, goalId, needId, 'short', j + 1, g)
      for (let k = 0; k < g.services.length; k++) {
        const s = g.services[k]
        const serviceId = randomUUID()
        serviceIds.set(s.id, serviceId)
        await insertService(c, targetPlanId, serviceId, needId, goalId, k + 1, s)
      }
    }
  }
  for (const slot of source.slots) {
    const serviceId = serviceIds.get(slot.serviceId)
    if (!serviceId) continue
    await c.query(
      `INSERT INTO care_plan_service_slots
         (id, plan_id, service_id, schedule_type, weekday, start_time, end_time, ends_next_day, note, period_from, period_to, ordinal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [randomUUID(), targetPlanId, serviceId, slot.scheduleType, slot.weekday, slot.start, slot.end, slot.endsNextDay, slot.note, slot.periodFrom, slot.periodTo, 1],
    )
  }
}

function insertGoal(
  c: Tx, planId: string, id: string, needId: string, level: 'long' | 'short', ordinal: number,
  g: { goal: string, periodText: string | null, periodFrom: string | null, periodTo: string | null },
) {
  return c.query(
    `INSERT INTO care_plan_goals (id, plan_id, need_id, level, ordinal, goal_text, period_text, period_from, period_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, planId, needId, level, ordinal, g.goal, g.periodText, g.periodFrom, g.periodTo],
  )
}

function insertService(
  c: Tx, planId: string, id: string, needId: string, shortGoalId: string, ordinal: number,
  s: { content: string, insured: boolean, kind: string | null, provider: string | null, frequency: string | null, periodText: string | null, periodFrom: string | null, periodTo: string | null },
) {
  return c.query(
    `INSERT INTO care_plan_services
       (id, plan_id, need_id, short_goal_id, ordinal, content, insured, service_kind, provider, frequency_text, period_text, period_from, period_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, planId, needId, shortGoalId, ordinal, s.content, s.insured, s.kind, s.provider, s.frequency, s.periodText, s.periodFrom, s.periodTo],
  )
}

function checkPeriod(path: string, from: string | null, to: string | null, problems: { path: string, reason: string }[]) {
  if (from !== null && !isDate(from)) problems.push({ path, reason: 'invalid_date' })
  if (to !== null && !isDate(to)) problems.push({ path, reason: 'invalid_date' })
  if (from && to && from > to) problems.push({ path, reason: 'period_order' })
}

/** 第2表の構造を置き換える。ID のある行は同じ ID のまま更新し、無い行は新しく作る */
export async function saveCarePlanNeeds(db: Db, staff: Staff, planId: string, baseVersion: number, needs: NeedInput[]): Promise<CarePlanView> {
  return tx(db, async (c) => {
    const plan = await lockPlan(c, staff.officeId, planId)
    checkBase(plan, baseVersion)
    const s = await readStructure(c, plan.id)
    const problems: { path: string, reason: string }[] = []
    const existingNeeds = new Map(s.needs.map((n) => [n.id, n]))
    const existingGoals = new Map(s.goals.map((g) => [g.id, g]))
    const existingServices = new Map(s.services.map((x) => [x.id, x]))
    const seenNeeds = new Set<string>()
    const seenGoals = new Set<string>()
    const seenServices = new Set<string>()

    interface PlannedService {
      id: string
      content: string
      insured: boolean
      kind: string | null
      provider: string | null
      frequency: string | null
      periodText: string | null
      periodFrom: string | null
      periodTo: string | null
    }
    interface PlannedShort {
      id: string
      goal: string
      periodText: string | null
      periodFrom: string | null
      periodTo: string | null
      services: PlannedService[]
    }
    interface PlannedNeed {
      id: string
      need: string
      longGoal: { id: string, goal: string, periodText: string | null, periodFrom: string | null, periodTo: string | null }
      shortGoals: PlannedShort[]
    }

    const planned: PlannedNeed[] = []
    for (let i = 0; i < needs.length; i++) {
      const n = needs[i]
      const path = `needs[${i}]`
      const needText = n.need?.trim() ?? ''
      if (!needText) problems.push({ path: `${path}.need`, reason: 'required' })
      let needId = n.id ?? ''
      if (needId) {
        if (!isUuid(needId) || !existingNeeds.has(needId) || seenNeeds.has(needId)) problems.push({ path: `${path}.id`, reason: 'unknown_id' })
        seenNeeds.add(needId)
      } else needId = randomUUID()

      const long = n.longGoal
      let longId = long.id ?? ''
      if (longId) {
        const g = existingGoals.get(longId)
        if (!isUuid(longId) || !g || g.level !== 'long' || g.needId !== (n.id ?? '') || seenGoals.has(longId)) {
          problems.push({ path: `${path}.longGoal.id`, reason: 'unknown_id' })
        }
        seenGoals.add(longId)
      } else {
        longId = s.goals.find((g) => g.needId === (n.id ?? '') && g.level === 'long')?.id ?? randomUUID()
      }
      const longText = long.goal?.trim() ?? ''
      if (!longText) problems.push({ path: `${path}.longGoal.goal`, reason: 'required' })
      const longFrom = long.periodFrom ?? plan.effectiveFrom
      const longTo = long.periodTo ?? plan.effectiveTo
      checkPeriod(`${path}.longGoal`, longFrom, longTo, problems)

      const shorts: PlannedShort[] = []
      for (let j = 0; j < (n.shortGoals ?? []).length; j++) {
        const g = n.shortGoals![j]
        const gpath = `${path}.shortGoals[${j}]`
        const goalText = g.goal?.trim() ?? ''
        if (!goalText) problems.push({ path: `${gpath}.goal`, reason: 'required' })
        let goalId = g.id ?? ''
        if (goalId) {
          const old = existingGoals.get(goalId)
          if (!isUuid(goalId) || !old || old.level !== 'short' || old.needId !== (n.id ?? '') || seenGoals.has(goalId)) {
            problems.push({ path: `${gpath}.id`, reason: 'unknown_id' })
          }
          seenGoals.add(goalId)
        } else goalId = randomUUID()
        const from = g.periodFrom ?? plan.effectiveFrom
        const to = g.periodTo ?? plan.effectiveTo
        checkPeriod(gpath, from, to, problems)

        const services: PlannedService[] = []
        for (let k = 0; k < (g.services ?? []).length; k++) {
          const x = g.services![k]
          const spath = `${gpath}.services[${k}]`
          const content = x.content?.trim() ?? ''
          if (!content) problems.push({ path: `${spath}.content`, reason: 'required' })
          let serviceId = x.id ?? ''
          if (serviceId) {
            const old = existingServices.get(serviceId)
            if (!isUuid(serviceId) || !old || seenServices.has(serviceId)) problems.push({ path: `${spath}.id`, reason: 'unknown_id' })
            else if (old.needId !== (n.id ?? '')) problems.push({ path: `${spath}.id`, reason: 'service_goal_mismatch' })
            seenServices.add(serviceId)
          } else serviceId = randomUUID()
          const sFrom = x.periodFrom ?? plan.effectiveFrom
          const sTo = x.periodTo ?? plan.effectiveTo
          checkPeriod(spath, sFrom, sTo, problems)
          services.push({
            id: serviceId,
            content,
            insured: x.insured ?? true,
            kind: x.kind ?? null,
            provider: x.provider ?? null,
            frequency: x.frequency ?? null,
            periodText: x.periodText ?? null,
            periodFrom: sFrom,
            periodTo: sTo,
          })
        }
        shorts.push({
          id: goalId, goal: goalText,
          periodText: g.periodText ?? null, periodFrom: from, periodTo: to,
          services,
        })
      }
      planned.push({
        id: needId, need: needText,
        longGoal: { id: longId, goal: longText, periodText: long.periodText ?? null, periodFrom: longFrom, periodTo: longTo },
        shortGoals: shorts,
      })
    }
    if (problems.length) throw new PlanValidationFailed(problems)

    // 先に更新・追加する（並べ替えは遅延可能な一意制約の中で行う）
    for (let i = 0; i < planned.length; i++) {
      const n = planned[i]
      await c.query(
        `INSERT INTO care_plan_needs (id, plan_id, ordinal, need_text) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET ordinal = EXCLUDED.ordinal, need_text = EXCLUDED.need_text, updated_at = now()`,
        [n.id, plan.id, i + 1, n.need],
      )
      await upsertGoal(c, plan.id, n.longGoal.id, n.id, 'long', 1, n.longGoal)
      for (let j = 0; j < n.shortGoals.length; j++) {
        const g = n.shortGoals[j]
        await upsertGoal(c, plan.id, g.id, n.id, 'short', j + 1, g)
        for (let k = 0; k < g.services.length; k++) {
          const sv = g.services[k]
          await upsertService(c, plan.id, sv.id, n.id, g.id, k + 1, sv)
        }
      }
    }

    // 送られなかった行を消す（ニーズを消すと目標・サービス・枠も消える）
    const serviceIds = planned.flatMap((n) => n.shortGoals.flatMap((g) => g.services.map((x) => x.id)))
    const goalIds = planned.flatMap((n) => [n.longGoal.id, ...n.shortGoals.map((g) => g.id)])
    const needIds = planned.map((n) => n.id)
    await c.query('DELETE FROM care_plan_services WHERE plan_id = $1 AND NOT (id = ANY($2::uuid[]))', [plan.id, serviceIds])
    await c.query('DELETE FROM care_plan_goals WHERE plan_id = $1 AND NOT (id = ANY($2::uuid[]))', [plan.id, goalIds])
    await c.query('DELETE FROM care_plan_needs WHERE plan_id = $1 AND NOT (id = ANY($2::uuid[]))', [plan.id, needIds])

    await bumpPlan(c, plan.id)
    await audit(c, staff, staff.officeId, 'care_plan.needs', { clientId: plan.clientId }, { planId: plan.id, needs: planned.length })
    return getCarePlan(c, staff.officeId, plan.id)
  })
}

function upsertGoal(
  c: Tx, planId: string, id: string, needId: string, level: 'long' | 'short', ordinal: number,
  g: { goal: string, periodText: string | null, periodFrom: string | null, periodTo: string | null },
) {
  return c.query(
    `INSERT INTO care_plan_goals (id, plan_id, need_id, level, ordinal, goal_text, period_text, period_from, period_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       need_id = EXCLUDED.need_id, level = EXCLUDED.level, ordinal = EXCLUDED.ordinal,
       goal_text = EXCLUDED.goal_text, period_text = EXCLUDED.period_text,
       period_from = EXCLUDED.period_from, period_to = EXCLUDED.period_to, updated_at = now()`,
    [id, planId, needId, level, ordinal, g.goal, g.periodText, g.periodFrom, g.periodTo],
  )
}

function upsertService(
  c: Tx, planId: string, id: string, needId: string, shortGoalId: string, ordinal: number,
  s: { content: string, insured: boolean, kind: string | null, provider: string | null, frequency: string | null, periodText: string | null, periodFrom: string | null, periodTo: string | null },
) {
  return c.query(
    `INSERT INTO care_plan_services
       (id, plan_id, need_id, short_goal_id, ordinal, content, insured, service_kind, provider, frequency_text, period_text, period_from, period_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO UPDATE SET
       need_id = EXCLUDED.need_id, short_goal_id = EXCLUDED.short_goal_id, ordinal = EXCLUDED.ordinal,
       content = EXCLUDED.content, insured = EXCLUDED.insured, service_kind = EXCLUDED.service_kind,
       provider = EXCLUDED.provider, frequency_text = EXCLUDED.frequency_text, period_text = EXCLUDED.period_text,
       period_from = EXCLUDED.period_from, period_to = EXCLUDED.period_to, updated_at = now()`,
    [id, planId, needId, shortGoalId, ordinal, s.content, s.insured, s.kind, s.provider, s.frequency, s.periodText, s.periodFrom, s.periodTo],
  )
}

async function bumpPlan(c: Tx, planId: string) {
  await c.query('UPDATE care_plans SET lock_version = lock_version + 1, updated_at = now() WHERE id = $1', [planId])
  await c.query(
    'UPDATE clients c SET updated_at = now() FROM care_plans p WHERE p.id = $1 AND c.id = p.client_id',
    [planId],
  )
}

/** 第2表の plan.needs に射影する形（stable ID は入れない） */
function needsProjection(needs: NeedView[]) {
  const period = (p: { periodText: string | null, periodFrom: string | null, periodTo: string | null }) =>
    p.periodText?.trim() || (p.periodFrom || p.periodTo ? `${p.periodFrom ?? ''}〜${p.periodTo ?? ''}` : '')
  return needs.map((n) => ({
    need: n.need,
    longGoal: n.longGoal.goal,
    longGoalPeriod: period(n.longGoal),
    shortGoals: n.shortGoals.map((g) => ({
      goal: g.goal,
      period: period(g),
      services: g.services.map((s) => ({
        content: s.content,
        insured: s.insured,
        kind: s.kind ?? '',
        provider: s.provider ?? '',
        frequency: s.frequency ?? '',
        period: period(s),
      })),
    })),
  }))
}

/** 第3表の plan.weekly / plan.nonWeeklyServices に射影する形 */
function scheduleProjection(needs: NeedView[], slots: SlotView[]) {
  const services = new Map(needs.flatMap((n) => n.shortGoals.flatMap((g) => g.services)).map((s) => [s.id, s.content]))
  const weekly = slots
    .filter((s) => s.scheduleType === 'weekly' && s.weekday !== null && s.start && s.end)
    .map((s) => ({ day: dayName(s.weekday!), start: s.start!, end: s.end!, service: services.get(s.serviceId) ?? '' }))
  const nonWeekly = slots
    .filter((s) => s.scheduleType === 'other' && s.note)
    .map((s) => `${services.get(s.serviceId) ?? ''}: ${s.note}`)
    .join('\n')
  return { weekly, nonWeeklyServices: nonWeekly }
}

async function project(c: Tx, staff: Staff, plan: { id: string, clientId: string }, documentId: string, values: Record<string, unknown>, versionId: string) {
  const allowed = new Set((await loadFormDef(c, versionId)).keys)
  for (const [key, value] of Object.entries(values)) {
    if (allowed.has(key)) await writeField(c, staff.officeId, plan.clientId, documentId, key, value, 'ai', staff.id, { aiValue: value })
  }
}

/** 計画版の3表を保存する。第2・3表は構造から射影してから保存する */
export async function saveCarePlan(db: Db, staff: Staff, planId: string, baseVersion: number) {
  return tx(db, async (c) => {
    const plan = await lockPlan(c, staff.officeId, planId)
    checkBase(plan, baseVersion)
    const view = await getCarePlan(c, staff.officeId, plan.id)
    const doc = (formNo: 1 | 2 | 3) => {
      const d = view.documents.find((x) => x.formNo === formNo)
      if (!d) throw new NotFound(plan.id)
      return d
    }

    const needs = await readNeeds(c, plan.id)
    const slots = await readSlots(c, plan.id)
    const projection2 = { 'plan.needs': needsProjection(needs) }
    const schedule = scheduleProjection(needs, slots)
    await project(c, staff, plan, doc(2).documentId, projection2, doc(2).formVersionId)
    await project(c, staff, plan, doc(3).documentId, {
      'plan.weekly': schedule.weekly,
      'plan.nonWeeklyServices': schedule.nonWeeklyServices,
    }, doc(3).formVersionId)

    const revisions: { formNo: 1 | 2 | 3, rev: number }[] = []
    for (const formNo of [1, 2, 3] as const) {
      const r = await saveDocumentInTx(c, staff, doc(formNo).documentId, { scope: 'document' })
      revisions.push({ formNo, rev: r.rev })
    }
    await c.query('UPDATE care_plans SET saved_structure = $2 WHERE id = $1', [plan.id, JSON.stringify({ needs, slots })])
    await bumpPlan(c, plan.id)
    await audit(c, staff, staff.officeId, 'care_plan.save', { clientId: plan.clientId, documentId: doc(1).documentId }, {
      planId: plan.id, revisions,
    })
    return { plan: await getCarePlan(c, staff.officeId, plan.id), revisions }
  })
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null
}

/** キー順に依存しない JSON。ハッシュと保存済み判定で同じ正規化を使う。 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** #94 はこのスナップショットだけを読み、編集中の計画版を再参照しない。 */
export async function confirmCarePlan(db: Db, staff: Staff, planId: string, baseVersion: number) {
  return tx(db, async (c) => {
    const initial = await getCarePlan(c, staff.officeId, planId)
    // 同じ利用者の同時確定を直列化する（古い確定版の置換も同じロック内）。
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 90))', [initial.clientId])
    const plan = await lockPlan(c, staff.officeId, planId)
    checkBase(plan, baseVersion)
    const view = await getCarePlan(c, staff.officeId, planId)
    const saved = (await c.query('SELECT saved_structure FROM care_plans WHERE id = $1', [planId])).rows[0].saved_structure
    if (!saved || canonical(saved) !== canonical({ needs: view.needs, slots: view.slots })) throw new PlanUnsavedChanges()
    const revisions: { documentId: string, revisionId: string, values: Record<string, unknown> }[] = []
    for (const document of view.documents) {
      await c.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [document.documentId])
      const latest = (await c.query(
        'SELECT id, "values", template_version_id FROM revisions WHERE document_id = $1 ORDER BY rev DESC LIMIT 1',
        [document.documentId],
      )).rows[0]
      const fields = await readFields(c, document.documentId)
      const current = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]))
      if (!latest || latest.template_version_id !== document.formVersionId || canonical(latest.values) !== canonical(current)) throw new PlanUnsavedChanges()
      revisions.push({ documentId: document.documentId, revisionId: latest.id, values: latest.values })
    }
    if (revisions.length !== 3) throw new PlanUnsavedChanges()
    const snapshot = {
      schemaVersion: 1,
      plan: { id: view.id, clientId: view.clientId, effectiveFrom: view.effectiveFrom, effectiveTo: view.effectiveTo },
      plan1: revisions[0].values,
      needs: view.needs,
      slots: view.slots,
      services: view.needs.flatMap((n) => n.shortGoals.flatMap((g) => g.services.map((s) => ({
        serviceId: s.id, needId: n.id, shortGoalId: g.id, content: s.content, serviceKind: s.kind,
        provider: s.provider, insured: s.insured, frequencyText: s.frequency,
        periodFrom: s.periodFrom, periodTo: s.periodTo,
        weekly: view.slots.filter((slot) => slot.serviceId === s.id && slot.scheduleType === 'weekly').map((slot) => ({
          slotId: slot.id, weekday: slot.weekday, start: slot.start, end: slot.end, endsNextDay: slot.endsNextDay,
          periodFrom: slot.periodFrom, periodTo: slot.periodTo,
        })),
        other: view.slots.filter((slot) => slot.serviceId === s.id && slot.scheduleType === 'other').map((slot) => ({
          slotId: slot.id, note: slot.note, periodFrom: slot.periodFrom, periodTo: slot.periodTo,
        })),
      })))),
    }
    const hash = createHash('sha256').update(canonical(snapshot)).digest('hex')
    await c.query("UPDATE care_plans SET status = 'superseded', updated_at = now() WHERE client_id = $1 AND status = 'confirmed'", [plan.clientId])
    await c.query("UPDATE care_plans SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2, lock_version = lock_version + 1, updated_at = now() WHERE id = $1", [planId, staff.id])
    const confirmation = (await c.query(
      `INSERT INTO care_plan_confirmations
       (plan_id, document_1_id, document_1_revision_id, document_2_id, document_2_revision_id,
        document_3_id, document_3_revision_id, snapshot, snapshot_sha256, confirmed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, confirmed_at`,
      [planId, revisions[0].documentId, revisions[0].revisionId, revisions[1].documentId, revisions[1].revisionId,
        revisions[2].documentId, revisions[2].revisionId, JSON.stringify(snapshot), hash, staff.id],
    )).rows[0]
    await audit(c, staff, staff.officeId, 'care_plan.confirm', { clientId: plan.clientId }, { planId, confirmationId: confirmation.id, snapshotSha256: hash })
    return {
      plan: await getCarePlan(c, staff.officeId, planId),
      confirmation: { id: confirmation.id as string, snapshotSha256: hash, confirmedAt: new Date(confirmation.confirmed_at).toISOString() },
    }
  })
}

/** PDF は保存済みの3表だけから作る。編集中の構造や確定と食い違う版は出力しない。 */
export async function carePlanPdfSources(db: Db, staff: Staff, planId: string) {
  return tx(db, async (c) => {
    const initial = await getCarePlan(c, staff.officeId, planId)
    await c.query('SELECT id FROM care_plans WHERE id = $1 AND office_id = $2 FOR UPDATE', [planId, staff.officeId])
    const view = await getCarePlan(c, staff.officeId, planId)
    const saved = (await c.query('SELECT saved_structure FROM care_plans WHERE id = $1', [planId])).rows[0].saved_structure
    if (!saved || canonical(saved) !== canonical({ needs: view.needs, slots: view.slots })) throw new PlanUnsavedChanges()
    const sources: { formNo: 1 | 2 | 3, documentId: string, revisionId: string, rev: number, formVersionId: string, values: Record<string, unknown> }[] = []
    for (const document of view.documents) {
      await c.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [document.documentId])
      const revision = (await c.query('SELECT id, rev, template_version_id, "values" FROM revisions WHERE document_id = $1 ORDER BY rev DESC LIMIT 1', [document.documentId])).rows[0]
      if (!revision) throw new PlanUnsavedChanges()
      sources.push({
        formNo: document.formNo, documentId: document.documentId, revisionId: String(revision.id),
        rev: Number(revision.rev), formVersionId: revision.template_version_id, values: revision.values,
      })
    }
    if (sources.length !== 3) throw new PlanUnsavedChanges()
    if (view.status !== 'draft') {
      const confirmation = (await c.query('SELECT * FROM care_plan_confirmations WHERE plan_id = $1', [planId])).rows[0]
      if (!confirmation || sources.some((s) => String(confirmation[`document_${s.formNo}_revision_id`]) !== s.revisionId) ||
          canonical(confirmation.snapshot.plan1) !== canonical(sources[0].values) ||
          canonical(confirmation.snapshot.needs) !== canonical(view.needs) ||
          canonical(confirmation.snapshot.slots) !== canonical(view.slots)) throw new PlanUnsavedChanges()
      if (createHash('sha256').update(canonical(confirmation.snapshot)).digest('hex') !== confirmation.snapshot_sha256) throw new PlanUnsavedChanges()
    }
    return { clientId: initial.clientId, sources }
  })
}

/** AI の出力の形を確かめる。形が違えば null（failed / invalid_json） */
function normalizeAiProposal(raw: unknown): { plan1: Record<string, unknown>, needs: unknown[], slots: unknown[], conflicts: unknown[] } | null {
  const r = asRecord(raw)
  if (!r) return null
  const plan1 = r.plan1 === undefined ? {} : asRecord(r.plan1)
  if (!plan1) return null
  if (r.needs !== undefined && !Array.isArray(r.needs)) return null
  if (r.slots !== undefined && !Array.isArray(r.slots)) return null
  if (r.conflicts !== undefined && !Array.isArray(r.conflicts)) return null
  return {
    plan1,
    needs: (r.needs as unknown[] | undefined) ?? [],
    slots: (r.slots as unknown[] | undefined) ?? [],
    conflicts: (r.conflicts as unknown[] | undefined) ?? [],
  }
}

export async function createCarePlanAiDraft(
  db: Db, staff: Staff, planId: string, sourceDocumentId: string, sourceRevisionId: number, drafter: CarePlanDrafter,
): Promise<AiDraftDetail> {
  const plan = await getCarePlan(db, staff.officeId, planId)
  if (plan.status !== 'draft') throw new PlanNotDraft()
  let src: Record<string, unknown> | undefined
  try {
    src = (await db.query(
      `SELECT r.id, r.rev, r.document_id, r.template_version_id, r.saved_at, r."values", d.office_id, d.client_id, d.kind, c.name AS client_name
       FROM revisions r JOIN documents d ON d.id = r.document_id JOIN clients c ON c.id = d.client_id
       WHERE r.id = $1 AND r.document_id = $2`,
      [sourceRevisionId, sourceDocumentId],
    )).rows[0]
  } catch (e) {
    if ((e as { code?: string }).code === '22P02') throw new NotFound(sourceDocumentId)
    throw e
  }
  if (!src || src.office_id !== staff.officeId || src.client_id !== plan.clientId || src.kind !== 'assessment') throw new NotFound(sourceDocumentId)

  const reference = {
    documentId: src.document_id as string,
    revisionId: Number(src.id),
    rev: Number(src.rev),
    formVersionId: src.template_version_id as string,
    savedAt: iso(src.saved_at),
    values: src.values as Record<string, unknown>,
  }
  let status: AiDraftDetail['status'] = 'proposed'
  let errorKind: string | null = null
  let proposal: { plan1: Record<string, unknown>, needs: unknown[], slots: unknown[], conflicts: unknown[] } = {
    plan1: {}, needs: [], slots: [], conflicts: [],
  }
  try {
    const raw = await drafter({ plan, clientName: src.client_name as string, source: reference })
    const normalized = normalizeAiProposal(raw)
    if (!normalized) {
      status = 'failed'
      errorKind = 'invalid_json'
    } else proposal = normalized
  } catch (e) {
    status = 'failed'
    errorKind = e instanceof SyntaxError ? 'invalid_json' : 'ai_failed'
  }

  return tx(db, async (c) => {
    const current = (await c.query('SELECT status FROM care_plans WHERE id = $1 AND office_id = $2 FOR UPDATE', [plan.id, staff.officeId])).rows[0]
    if (!current) throw new NotFound(plan.id)
    if (current.status !== 'draft') throw new PlanNotDraft()
    const row = (await c.query(
      `INSERT INTO care_plan_ai_drafts
         (office_id, client_id, plan_id, source_document_id, source_revision_id, source_revision_rev,
          source_form_version_id, source_saved_at, status, prompt_version, proposal, conflicts, error_kind, created_by)
       SELECT $1,$2,$3,r.document_id,r.id,r.rev,r.template_version_id,r.saved_at,$4,$5,$6,$7,$8,$9
       FROM revisions r WHERE r.id = $10
       RETURNING id, plan_id, status, source_document_id, source_revision_id, source_revision_rev, referenced_at, proposal, conflicts, applied, error_kind`,
      [
        staff.officeId, plan.clientId, plan.id, status, 'care-plan-draft-v2',
        JSON.stringify(proposal), JSON.stringify(proposal.conflicts), errorKind, staff.id, sourceRevisionId,
      ],
    )).rows[0]
    if (!row) throw new NotFound(sourceDocumentId)
    await audit(c, staff, staff.officeId, 'care_plan.ai_draft', { clientId: plan.clientId }, {
      planId: plan.id, draftId: row.id, status, sourceRevisionId,
    })
    return {
      id: row.id as string,
      planId: row.plan_id as string,
      status: row.status as AiDraftDetail['status'],
      sourceDocumentId: row.source_document_id as string,
      sourceRevisionId: Number(row.source_revision_id),
      sourceRevisionRev: Number(row.source_revision_rev),
      referencedAt: iso(row.referenced_at),
      proposal: row.proposal,
      conflicts: row.conflicts,
      applied: row.applied,
      errorKind: (row.error_kind as string | null) ?? null,
    }
  })
}

/** 保存した原案を再生成せずに開く。計画・原案の両方を事業所で絞る。 */
export async function getCarePlanAiDraft(db: Db, officeId: string, planId: string, draftId: string): Promise<AiDraftDetail> {
  const row = (await db.query(
    `SELECT d.* FROM care_plan_ai_drafts d
     JOIN care_plans p ON p.id = d.plan_id AND p.office_id = d.office_id
     WHERE d.id = $1 AND d.plan_id = $2 AND d.office_id = $3`,
    [draftId, planId, officeId],
  )).rows[0]
  if (!row) throw new NotFound(draftId)
  return {
    id: row.id as string, planId: row.plan_id as string,
    status: row.status as AiDraftDetail['status'],
    sourceDocumentId: row.source_document_id as string,
    sourceRevisionId: Number(row.source_revision_id), sourceRevisionRev: Number(row.source_revision_rev),
    referencedAt: iso(row.referenced_at), proposal: row.proposal, conflicts: row.conflicts,
    applied: row.applied, errorKind: (row.error_kind as string | null) ?? null,
  }
}

export interface ApplyResult {
  plan: CarePlanView
  applied: { fields: string[], needs: string[], slots: string[], skipped: { target: string, reason: string }[] }
}

/** AI 原案を適用する。第1表は人が直した欄を上書きせず、第2表は同じ内容の行を増やさない */
export async function applyCarePlanAiDraft(
  db: Db, staff: Staff, planId: string, draftId: string, baseVersion: number,
): Promise<ApplyResult> {
  return tx(db, async (c) => {
    const plan = await lockPlan(c, staff.officeId, planId)
    checkBase(plan, baseVersion)
    let draft: Record<string, unknown> | undefined
    try {
      draft = (await c.query(
        'SELECT * FROM care_plan_ai_drafts WHERE id = $1 AND plan_id = $2 AND office_id = $3 FOR UPDATE',
        [draftId, plan.id, staff.officeId],
      )).rows[0]
    } catch (e) {
      if ((e as { code?: string }).code === '22P02') throw new NotFound(draftId)
      throw e
    }
    if (!draft) throw new NotFound(draftId)
    if (draft.status === 'failed') throw new BadRequest('失敗した AI 原案は適用できません')
    if (draft.status !== 'proposed') return { plan: await getCarePlan(c, staff.officeId, plan.id), applied: { fields: [], needs: [], slots: [], skipped: [{ target: 'draft', reason: 'already_applied' }] } }

    const view = await getCarePlan(c, staff.officeId, plan.id)
    const doc1 = view.documents.find((d) => d.formNo === 1)
    if (!doc1) throw new NotFound(plan.id)
    const allowed = new Set((await loadFormDef(c, doc1.formVersionId)).keys)
    const current = await readFields(c, doc1.documentId)
    const proposal = asRecord(draft.proposal) ?? {}
    const plan1 = asRecord(proposal.plan1) ?? {}
    const appliedFields: string[] = []
    const skipped: { target: string, reason: string }[] = []
    for (const [key, value] of Object.entries(plan1)) {
      if (!allowed.has(key) || !validValue(key, value)) {
        skipped.push({ target: key, reason: 'unknown_target' })
        continue
      }
      if (value === null || value === '') {
        skipped.push({ target: key, reason: 'empty' })
        continue
      }
      if (current[key]?.by === 'cm') {
        skipped.push({ target: key, reason: 'human_value' })
        continue
      }
      if (current[key]?.value != null && current[key].value !== '') {
        skipped.push({ target: key, reason: 'existing' })
        continue
      }
      await writeField(c, staff.officeId, plan.clientId, doc1.documentId, key, value, 'ai', staff.id, {
        aiValue: value, cite: { kind: 'care-plan-ai-draft', draftId },
      })
      appliedFields.push(key)
    }

    const structure = await readStructure(c, plan.id)
    const existingNeeds = new Set(structure.needs.map((n) => n.need))
    const rawNeeds = Array.isArray(proposal.needs) ? proposal.needs : []
    const appliedNeeds: string[] = []
    const createdServices = new Map<string, string>()
    for (let i = 0; i < rawNeeds.length; i++) {
      const n = asRecord(rawNeeds[i])
      const needText = typeof n?.need === 'string' ? n.need.trim() : ''
      if (!n || !needText) {
        skipped.push({ target: `needs[${i}]`, reason: 'invalid_value' })
        continue
      }
      if (existingNeeds.has(needText)) {
        skipped.push({ target: `needs[${i}]`, reason: 'existing' })
        continue
      }
      const long = asRecord(n.longGoal)
      const longText = typeof long?.goal === 'string' ? long.goal.trim() : ''
      if (!longText) {
        skipped.push({ target: `needs[${i}]`, reason: 'invalid_value' })
        continue
      }
      const needId = randomUUID()
      await c.query(
        'INSERT INTO care_plan_needs (id, plan_id, ordinal, need_text) VALUES ($1,$2,$3,$4)',
        [needId, plan.id, structure.needs.length + appliedNeeds.length + 1, needText],
      )
      await insertGoal(c, plan.id, randomUUID(), needId, 'long', 1, {
        goal: longText,
        periodText: typeof long?.periodText === 'string' ? long.periodText : null,
        periodFrom: typeof long?.periodFrom === 'string' ? long.periodFrom : plan.effectiveFrom,
        periodTo: typeof long?.periodTo === 'string' ? long.periodTo : plan.effectiveTo,
      })
      const shorts = Array.isArray(n.shortGoals) ? n.shortGoals : []
      for (let j = 0; j < shorts.length; j++) {
        const g = asRecord(shorts[j])
        const goalText = typeof g?.goal === 'string' ? g.goal.trim() : ''
        if (!g || !goalText) continue
        const goalId = randomUUID()
        await insertGoal(c, plan.id, goalId, needId, 'short', j + 1, {
          goal: goalText,
          periodText: typeof g.periodText === 'string' ? g.periodText : null,
          periodFrom: typeof g.periodFrom === 'string' ? g.periodFrom : plan.effectiveFrom,
          periodTo: typeof g.periodTo === 'string' ? g.periodTo : plan.effectiveTo,
        })
        const services = Array.isArray(g.services) ? g.services : []
        for (let k = 0; k < services.length; k++) {
          const sv = asRecord(services[k])
          const content = typeof sv?.content === 'string' ? sv.content.trim() : ''
          if (!sv || !content) continue
          const serviceId = randomUUID()
          await insertService(c, plan.id, serviceId, needId, goalId, k + 1, {
            content,
            insured: typeof sv.insured === 'boolean' ? sv.insured : true,
            kind: typeof sv.kind === 'string' ? sv.kind : null,
            provider: typeof sv.provider === 'string' ? sv.provider : null,
            frequency: typeof sv.frequency === 'string' ? sv.frequency : null,
            periodText: typeof sv.periodText === 'string' ? sv.periodText : null,
            periodFrom: typeof sv.periodFrom === 'string' ? sv.periodFrom : plan.effectiveFrom,
            periodTo: typeof sv.periodTo === 'string' ? sv.periodTo : plan.effectiveTo,
          })
          createdServices.set(`${i}:${j}:${k}`, serviceId)
        }
      }
      existingNeeds.add(needText)
      appliedNeeds.push(needId)
    }
    const appliedSlots: string[] = []
    const schedule = await getCarePlan(c, staff.officeId, plan.id)
    const rawSlots = Array.isArray(proposal.slots) ? proposal.slots : []
    for (const [index, raw] of rawSlots.entries()) {
      const target = `slots[${index}]`
      const parsed = AiPlanSlotSchema.safeParse(raw)
      if (!parsed.success) { skipped.push({ target, reason: 'invalid_value' }); continue }
      const { serviceRef, ...input } = parsed.data
      const serviceId = createdServices.get(`${serviceRef.need}:${serviceRef.shortGoal}:${serviceRef.service}`)
      if (!serviceId) { skipped.push({ target, reason: 'service_not_created' }); continue }
      let slot: SlotView
      try {
        slot = validatedSlots(schedule, [...schedule.slots, { ...input, serviceId }]).at(-1)!
      } catch (error) {
        if (!(error instanceof PlanValidationFailed)) throw error
        skipped.push({ target, reason: error.problems[0]?.reason ?? 'invalid_value' }); continue
      }
      await c.query(`INSERT INTO care_plan_service_slots
        (id, plan_id, service_id, schedule_type, weekday, start_time, end_time, ends_next_day, note, period_from, period_to, ordinal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [slot.id, plan.id, slot.serviceId, slot.scheduleType, slot.weekday, slot.start, slot.end, slot.endsNextDay, slot.note, slot.periodFrom, slot.periodTo, schedule.slots.length + 1])
      schedule.slots.push(slot)
      appliedSlots.push(slot.id)
    }

    const status = appliedFields.length || appliedNeeds.length || appliedSlots.length ? (skipped.length ? 'partially_applied' : 'applied') : 'partially_applied'
    await c.query(
      `UPDATE care_plan_ai_drafts
       SET status = $2, applied = $3, applied_by = $4, applied_at = now()
       WHERE id = $1`,
      [draft.id, status, JSON.stringify({ fields: appliedFields, needs: appliedNeeds, slots: appliedSlots, skipped }), staff.id],
    )
    await bumpPlan(c, plan.id)
    await audit(c, staff, staff.officeId, 'care_plan.ai_apply', { clientId: plan.clientId }, {
      planId: plan.id, draftId: draft.id, fields: appliedFields.length, needs: appliedNeeds.length, slots: appliedSlots.length, skipped: skipped.length,
    })
    return {
      plan: await getCarePlan(c, staff.officeId, plan.id),
      applied: { fields: appliedFields, needs: appliedNeeds, slots: appliedSlots, skipped },
    }
  })
}

const PROJECTION_KEYS: Record<2 | 3, Set<string>> = {
  2: new Set(['plan.needs']),
  3: new Set(['plan.weekly', 'plan.nonWeeklyServices']),
}

/** その書類が計画版の第2表・第3表なら表番号を返す（ちがえば null） */
export async function planFormNoOfDocument(db: Q, officeId: string, documentId: string): Promise<2 | 3 | null> {
  let r: Record<string, unknown> | undefined
  try {
    r = (await db.query(
      `SELECT cpd.form_no FROM care_plan_documents cpd JOIN care_plans p ON p.id = cpd.plan_id
       WHERE cpd.document_id = $1 AND p.office_id = $2`,
      [documentId, officeId],
    )).rows[0]
  } catch (e) {
    if ((e as { code?: string }).code === '22P02') return null
    throw e
  }
  const formNo = r ? Number(r.form_no) : 0
  return formNo === 2 || formNo === 3 ? formNo : null
}

/** 第2/3表の射影を汎用の欄の直しで変えようとしていないか */
export async function assertGenericDocumentEdits(db: Q, officeId: string, documentId: string, keys: string[]) {
  if ((await db.query("SELECT id FROM documents WHERE id=$1 AND office_id=$2 AND kind IN ('care_plan_6','care_plan_7')", [documentId, officeId])).rows.length) throw new UsePlanApi()
  await assertPlanDocumentDraft(db, officeId, documentId)
  const formNo = await planFormNoOfDocument(db, officeId, documentId)
  if (formNo && keys.some((k) => PROJECTION_KEYS[formNo].has(k))) throw new UsePlanApi()
}

/** 第2/3表を汎用の個別保存で変えようとしていないか */
export async function assertGenericDocumentSave(db: Q, officeId: string, documentId: string) {
  if ((await db.query("SELECT id FROM documents WHERE id=$1 AND office_id=$2 AND kind IN ('care_plan_6','care_plan_7')", [documentId, officeId])).rows.length) throw new UsePlanApi()
  await assertPlanDocumentDraft(db, officeId, documentId)
  if (await planFormNoOfDocument(db, officeId, documentId)) throw new UsePlanApi()
}

async function assertPlanDocumentDraft(db: Q, officeId: string, documentId: string) {
  // UUID でない通常の書類リクエストは既存の NotFound 処理に任せる。
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) return
  const result = await db.query(
    `SELECT p.status FROM care_plans p JOIN care_plan_documents d ON d.plan_id = p.id
     WHERE d.document_id = $1 AND p.office_id = $2`,
    [documentId, officeId],
  )
  if (result.rows[0] && result.rows[0].status !== 'draft') throw new PlanNotDraft()
}
