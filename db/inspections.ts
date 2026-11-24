// AI 点検（inspections・inspection_findings）の読み書き。api（care.work）と worker が使う。
// docs/再設計/13_DB設計.md の「点検」、16_書類と点検の基盤.md の「見せ方」。状態は queued → processing → succeeded／partial／failed。
import { createHash } from 'node:crypto'
import { categoryCounts, checkSet, checkSetSha, hasCheckSet, DEFAULT_CHECK_SET, isSatisfied, verdictOf, type CategoryCount, type Level, type Verdict } from '../core/checks/index.ts'
import type { Db } from './pool.ts'
import { inspectionProjection } from './care-plans.ts'
import { tx,type Tx } from './pool.ts'
import { inspectionCoverage,type InspectionCoverage } from '../core/checks/coverage.ts'
import { BadRequest, NotFound, type Staff } from './repo.ts'

type Q = Db | Tx
export type InspectionStatus = 'queued' | 'processing' | 'succeeded' | 'partial' | 'failed'

/** 点検を始めた回数の上限。使い切ったら failed */
export const MAX_INSPECTION_ATTEMPTS = 3

/** 読んだ書類（id・種類・保存した版の番号・保存していない値も読んだか） */
export interface InspectionInput { documentId: string, kind: string, rev: number, unsaved: boolean, role?: 'target'|'reference', formVersionId?:string }

export interface InspectionSummary {
  id: string
  documentId?: string | null
  documentName?: string | null
  status: InspectionStatus
  createdAt: string
  /** 点検を始めた職員の名前 */
  createdBy: string | null
  /** 終わっていなければ null */
  verdict: Verdict | null
  /** 段階が 1 の項目の数 */
  missingCount: number
  /** 段階の付いた項目の数 */
  total: number
}

export interface InspectionItem {
  id: string
  name: string
  category: string
  level: Level | null
  /** 段階が 1 のときだけ */
  missing: string | null
  /** 押したときに移る欄と書類。null は用紙に欄なし */
  fieldKey: string | null
  documentId: string | null
}

export interface InspectionView extends InspectionSummary {
  checkSet: string
  references: InspectionInput[]
  coverage: InspectionCoverage
  categories: CategoryCount[]
  /** 物差しの項目の順。点検していない項目は入れない */
  items: InspectionItem[]
  /** 対象書類のいちばん新しい点検か */
  latest: boolean
  /** いちばん新しい点検で、そのあとに読んだ書類の値が変わったか（ほかの点検と、終わっていない点検は null） */
  changed: boolean | null
}

/** 読んだ値の指紋。書類の id の順に、欄の key の順で並べた値 */
export function valuesSha(docs: { documentId: string, values: Record<string, unknown>, formVersionId?:string }[]): string {
  const canon = [...docs].sort((a, b) => a.documentId.localeCompare(b.documentId))
    .map((d) => [d.documentId, Object.keys(d.values).sort().map((k) => [k, d.values[k]]), ...(d.formVersionId?[d.formVersionId]:[])])
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}

/** 書類の今の値（空の値は入れない。指紋がぶれないように） */
export async function currentValues(db: Q, documentId: string): Promise<Record<string, unknown>> {
  const r = await db.query('SELECT key, value FROM field_values WHERE document_id = $1 AND value IS NOT NULL ORDER BY key', [documentId])
  return {...Object.fromEntries(r.rows.map((x) => [x.key, x.value])),...await inspectionProjection(db,documentId)}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function ownClient(db: Q, officeId: string, clientId: string) {
  if (!UUID.test(clientId) || !(await db.query('SELECT 1 FROM clients WHERE id = $1 AND office_id = $2', [clientId, officeId])).rows.length) throw new NotFound(clientId)
}

// ---------- api ----------

/** 点検を始める。同じ書類・物差しの点検が待っているか動いていれば、それを返す（2 つ走らない） */
export async function createInspection(db: Db, staff: Staff, clientId: string, set: string, documentId?:string): Promise<{ id: string, created: boolean }> {
 return tx(db,async c=>{
  await ownClient(c,staff.officeId,clientId)
  if(!hasCheckSet(set))throw new BadRequest('物差しがありません')
  await c.query('SELECT id FROM clients WHERE id=$1 AND office_id=$2 FOR UPDATE',[clientId,staff.officeId])
  const target=await inspectionTarget(c,staff.officeId,clientId,documentId)
  const active=(await c.query("SELECT id FROM inspections WHERE office_id=$1 AND client_id=$2 AND check_set=$3 AND (document_id=$4 OR (document_id IS NULL AND $5)) AND status IN ('queued','processing') ORDER BY created_at DESC LIMIT 1",[staff.officeId,clientId,set,target.id,target.primary])).rows[0]
  if(active)return {id:active.id,created:false}
  const r=await c.query("INSERT INTO inspections(office_id,client_id,document_id,check_set,check_set_sha,inputs,inputs_sha,created_by) VALUES($1,$2,$3,$4,$5,'[]','',$6) RETURNING id",[staff.officeId,clientId,target.id,set,checkSetSha(checkSet(set)),staff.id])
  return {id:r.rows[0].id,created:true}
 })
}
/** 省略時は従来の主な書類。複数の記録を「最新の1件」に置き換えない。 */
export async function inspectionTarget(db:Q,officeId:string,clientId:string,documentId?:string) {
 if(documentId&&!UUID.test(documentId))throw new NotFound()
 const r=(await db.query(`SELECT d.id,d.kind,k.name,k.is_primary AS primary FROM documents d JOIN form_kinds k ON k.key=d.kind WHERE d.office_id=$1 AND d.client_id=$2 AND ($3::uuid IS NOT NULL AND d.id=$3 OR $3::uuid IS NULL AND k.is_primary) ORDER BY d.created_at DESC,d.id LIMIT 1`,[officeId,clientId,documentId??null])).rows[0]
 if(!r)throw new NotFound()
 return r as {id:string;kind:string;name:string;primary:boolean}
}
export async function inspectionScope(db:Q,officeId:string,clientId:string,documentId?:string) {
 await ownClient(db,officeId,clientId)
 const target=await inspectionTarget(db,officeId,clientId,documentId)
 const kinds=(await db.query('SELECT DISTINCT kind FROM documents WHERE office_id=$1 AND client_id=$2',[officeId,clientId])).rows.map(r=>r.kind as string)
 const set=checkSet(DEFAULT_CHECK_SET)
 return {documentId:target.id,documentName:target.name,coverage:inspectionCoverage(set,new Set([target.kind]),new Set(kinds)),categories:[...new Set(set.items.filter(i=>i.docs.includes(target.kind)).map(i=>i.category))]}
}

const SUMMARY_SQL = `
  SELECT i.id, i.client_id, i.status, i.created_at, i.check_set, i.document_id, (SELECT name FROM form_kinds WHERE key=(SELECT kind FROM documents WHERE id=i.document_id)) AS document_name, i.steps, i.inputs, i.inputs_sha, s.name AS created_by,
         count(f.ai_level) FILTER (WHERE f.ai_level = '1') AS missing, count(f.ai_level) AS total
  FROM inspections i
  LEFT JOIN staff s ON s.id = i.created_by
  LEFT JOIN inspection_findings f ON f.inspection_id = i.id`

const done = (status: string) => status === 'succeeded' || status === 'partial'
const summary = (r: Record<string, any>): InspectionSummary => ({
  id: r.id, documentId:r.document_id??null,documentName:r.document_name??null,status: r.status, createdAt: (r.created_at as Date).toISOString(), createdBy: r.created_by ?? null,
  verdict: Number(r.missing)>0?'要確認':r.status==='succeeded'&&Number(r.total)>0?'適合':null,
  missingCount: Number(r.missing), total: Number(r.total),
})

/** これまでの点検（新しい順） */
export async function listInspections(db: Q, officeId: string, clientId: string, limit = 100, documentId?:string): Promise<InspectionSummary[]> {
  await ownClient(db, officeId, clientId)
  const target=documentId?await inspectionTarget(db,officeId,clientId,documentId):null
  const r = await db.query(`${SUMMARY_SQL} WHERE i.office_id = $1 AND i.client_id = $2 AND ($4::uuid IS NULL OR i.document_id=$4 OR (i.document_id IS NULL AND $5 AND i.status IN ('queued','processing'))) GROUP BY i.id, s.name ORDER BY i.created_at DESC, i.id LIMIT $3`, [officeId, clientId, limit,documentId??null,target?.primary??false])
  return r.rows.map(summary)
}

/** 点検 1 回の結果。ほかの事業所の点検は「無い」 */
export async function getInspection(db: Q, officeId: string, id: string): Promise<InspectionView> {
  if (!UUID.test(id)) throw new NotFound(id)
  const r = (await db.query(`${SUMMARY_SQL} WHERE i.id = $1 AND i.office_id = $2 GROUP BY i.id, s.name`, [id, officeId])).rows[0]
  if (!r) throw new NotFound(id)
  const base = summary(r)
  const set = checkSet(r.check_set)
  const rows = new Map((await db.query('SELECT item, ai_level, missing, field_key, document_id FROM inspection_findings WHERE inspection_id = $1', [id])).rows.map((f) => [f.item as string, f]))
  const inputs = r.inputs as InspectionInput[]
  const docOf = (kinds: string[]) => inputs.find((d) => kinds.includes(d.kind))?.documentId ?? null
  const items: InspectionItem[] = set.items.filter((i) => rows.has(i.id)).map((i) => {
    const f = rows.get(i.id)
    const level = (f.ai_level ?? null) as Level | null
    return {
      id: i.id, name: i.name, category: i.category, level,
      missing: level === '1' ? f.missing ?? null : null,
      fieldKey: f.field_key ?? null, documentId: f.field_key ? f.document_id??docOf(i.docs) : null,
    }
  })
  const levels = new Map(items.filter((i) => i.level).map((i) => [i.id, i.level as Level]))
  const latestId = (await db.query('SELECT id FROM inspections WHERE office_id = $1 AND client_id = $2 AND document_id IS NOT DISTINCT FROM $3::uuid ORDER BY created_at DESC, id LIMIT 1', [officeId, r.client_id,r.document_id??null])).rows[0]?.id
  const latest = latestId === id
  let changed: boolean | null = null
  if (latest && done(base.status)) {
    const now = await Promise.all(inputs.map(async (d) => ({ documentId: d.documentId, values: await currentValues(db, d.documentId), ...(d.formVersionId?{formVersionId:(await db.query('SELECT template_version_id FROM documents WHERE id=$1',[d.documentId])).rows[0]?.template_version_id}:{} ) })))
    changed = valuesSha(now) !== r.inputs_sha
  }
  return {
    ...base,
    verdict: base.missingCount>0?'要確認':base.status==='succeeded'&&levels.size>0?verdictOf(levels.values()):null,
    checkSet: r.check_set,
    references:inputs.filter(d=>d.role==='reference'),
    coverage:inspectionCoverage(set,new Set(inputs.filter(d=>d.role!=='reference').map(d=>d.kind)),new Set(r.steps?.collect?.availableKinds??inputs.map(d=>d.kind)),levels),
    categories: categoryCounts(set.items, levels),
    items,
    latest,
    changed,
  }
}

// ---------- worker ----------

export interface ClaimedInspection { id: string, officeId: string, clientId: string, checkSet: string, attempts: number,documentId:string|null }

/** 点検を始める印を付ける（期限つき）。同じ点検が 2 回届いても、2 つ目は null（何もしない） */
export async function claimInspection(db: Q, id: string, token: string): Promise<ClaimedInspection | null> {
  const r = (await db.query(
    `UPDATE inspections SET status = 'processing', attempts = attempts + 1, run_token = $2,
       lease_until = now() + interval '20 minutes', updated_at = now()
     WHERE id = $1 AND attempts < $3 AND (status = 'queued' OR (status = 'processing' AND lease_until < now()))
     RETURNING id, office_id, client_id, check_set, attempts, document_id`,
    [id, token, MAX_INSPECTION_ATTEMPTS],
  )).rows[0]
  return r ? { id: r.id, officeId: r.office_id, clientId: r.client_id, checkSet: r.check_set, attempts: Number(r.attempts),documentId:r.document_id??null } : null
}

/** 長い点検の間、印の期限を延ばす */
export async function extendInspectionLease(db: Q, id: string, token: string): Promise<boolean> {
  const r = await db.query(
    "UPDATE inspections SET lease_until = now() + interval '20 minutes' WHERE id = $1 AND run_token = $2 AND status = 'processing' AND lease_until > now() RETURNING id",
    [id, token],
  )
  return r.rows.length > 0
}

/** 失敗したとき。回数が残っていれば待ちに戻す（見回りかタスクのやり直しが拾う） */
export async function releaseInspection(db: Q, id: string, token: string, terminal: boolean, errorKind: string): Promise<void> {
  await db.query(
    'UPDATE inspections SET status = $3, error_kind = $4, lease_until = NULL, run_token = NULL, updated_at = now() WHERE id = $1 AND run_token = $2',
    [id, token, terminal ? 'failed' : 'queued', errorKind],
  )
}

/** 見回り: 回数を使い切ったものは failed にし、積み損ね（2 分より前から待っている）・止まったものの id を返す */
export async function inspectionsToRequeue(db: Q): Promise<string[]> {
  await db.query(
    "UPDATE inspections SET status = 'failed', lease_until = NULL, run_token = NULL, error_kind = coalesce(error_kind, 'AttemptsExhausted'), updated_at = now() WHERE attempts >= $1 AND (status = 'queued' OR (status = 'processing' AND lease_until < now()))",
    [MAX_INSPECTION_ATTEMPTS],
  )
  const r = await db.query(
    `SELECT id FROM inspections
     WHERE (status = 'queued' AND updated_at < now() - interval '2 minutes') OR (status = 'processing' AND lease_until < now())
     ORDER BY created_at LIMIT 20`,
  )
  return r.rows.map((x) => x.id)
}
