// ケアプラン（#90）の読み取り。計画版と第1〜3表の書類を、事業所で絞って返す。
// 仕様: docs/ケアプラン仕様.md。書き込みの API は PR2 以降で足す。
import type { Db, Tx } from './pool.ts'
import { NotFound } from './repo.ts'

type Q = Db | Tx

export type CarePlanStatus = 'draft' | 'confirmed' | 'superseded'

export interface CarePlanDocumentView {
  formNo: 1 | 2 | 3
  documentId: string
  formVersionId: string
  /** 保存済みの最新の版番号（まだ保存していなければ 0） */
  latestRevision: number
  savedAt: string | null
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
  documents: CarePlanDocumentView[]
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

const PLAN_COLUMNS = 'id, client_id, plan_series_id, version, status, effective_from, effective_to, previous_plan_id, lock_version'

const date = (v: unknown): string => {
  if (v instanceof Date) {
    // date 列は pg がローカル時刻の Date にする。日付だけを返す
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  }
  return String(v).slice(0, 10)
}

/** 計画版を1つ読む。ほかの事業所・存在しない ID は NotFound（404） */
export async function getCarePlan(db: Q, officeId: string, planId: string): Promise<CarePlanView> {
  let p: Record<string, unknown> | undefined
  try {
    p = (await db.query(`SELECT ${PLAN_COLUMNS} FROM care_plans WHERE id = $1 AND office_id = $2`, [planId, officeId])).rows[0]
  } catch (e) {
    // uuid の形でない ID も「無い」として扱う（存在を漏らさない）
    if ((e as { code?: string }).code === '22P02') throw new NotFound(planId)
    throw e
  }
  if (!p) throw new NotFound(planId)

  const docs = (await db.query(
    `SELECT cpd.form_no, cpd.document_id, d.template_version_id, coalesce(r.rev, 0) AS latest_revision, r.saved_at
     FROM care_plan_documents cpd
     JOIN documents d ON d.id = cpd.document_id
     LEFT JOIN LATERAL (
       SELECT rev, saved_at FROM revisions WHERE document_id = cpd.document_id ORDER BY rev DESC LIMIT 1
     ) r ON true
     WHERE cpd.plan_id = $1
     ORDER BY cpd.form_no`,
    [p.id],
  )).rows

  return {
    id: p.id as string,
    clientId: p.client_id as string,
    planSeriesId: p.plan_series_id as string,
    version: Number(p.version),
    status: p.status as CarePlanStatus,
    effectiveFrom: date(p.effective_from),
    effectiveTo: p.effective_to === null ? null : date(p.effective_to),
    previousPlanId: (p.previous_plan_id as string | null) ?? null,
    lockVersion: Number(p.lock_version),
    documents: docs.map((d) => ({
      formNo: Number(d.form_no) as 1 | 2 | 3,
      documentId: d.document_id as string,
      formVersionId: d.template_version_id as string,
      latestRevision: Number(d.latest_revision),
      savedAt: d.saved_at ? new Date(d.saved_at as Date).toISOString() : null,
    })),
  }
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
    effectiveTo: x.effective_to === null ? null : date(x.effective_to),
    updatedAt: new Date(x.updated_at as Date).toISOString(),
    confirmedAt: x.confirmed_at ? new Date(x.confirmed_at as Date).toISOString() : null,
  }))
}
