// 書類を作るときに AI が書く（#195）の仕事（document_fills）の読み書き。api（care.work）と worker が使う。
// 状態は queued → processing → succeeded／partial／failed。値を書類に入れるのは applyBatch（書き込みの記録は fill）。
import type { Db } from './pool.ts'
import { Conflict, NotFound, audit, type Staff } from './repo.ts'

type Q = Pick<Db, 'query'>
export type FillStatus = 'queued' | 'processing' | 'succeeded' | 'partial' | 'failed'
export type FillStep = 'read' | 'write' | 'check' | 'done'

/** 仕事を始めた回数の上限。使い切ったら failed */
export const MAX_FILL_ATTEMPTS = 3

export interface FillView {
  id: string
  status: FillStatus
  step: FillStep
  /** 書類に入れた欄の数（終わっていなければ 0） */
  changes: number
  /** 元の書類の種類の名前（「アセスメント」など） */
  sourceName: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 書類と、元にする書類（create_from の種類の、いちばん新しい書類）。ほかの事業所の書類は「無い」 */
async function documentAndSource(db: Q, officeId: string, documentId: string) {
  if (!UUID.test(documentId)) throw new NotFound(documentId)
  const d = (await db.query(
    `SELECT d.id, d.client_id, k.create_from, (SELECT name FROM form_kinds WHERE key = k.create_from) AS source_name,
       EXISTS (SELECT 1 FROM care_plan_documents p WHERE p.document_id = d.id) AS plan
     FROM documents d JOIN form_kinds k ON k.key = d.kind WHERE d.id = $1 AND d.office_id = $2`,
    [documentId, officeId],
  )).rows[0]
  if (!d) throw new NotFound(documentId)
  return d as { id: string, client_id: string, create_from: string | null, source_name: string | null, plan: boolean }
}

// ---------- api ----------

/**
 * AI に書いてもらう。元にする書類がなければ断る（ケアプランも対象外。別の作り方があるため）。
 * 同じ書類の仕事が待っているか動いていれば、それを返す（2 つ走らない）
 */
export async function startFill(db: Db, staff: Staff, documentId: string): Promise<{ id: string, created: boolean }> {
  const d = await documentAndSource(db, staff.officeId, documentId)
  if (!d.create_from || d.plan) throw new Conflict('この書類は、ほかの書類を元に AI が書くことはできません')
  const src = (await db.query(
    'SELECT id FROM documents WHERE client_id = $1 AND kind = $2 ORDER BY seq DESC, created_at DESC LIMIT 1',
    [d.client_id, d.create_from],
  )).rows[0]
  if (!src) throw new Conflict(`元にする${d.source_name ?? '書類'}がありません`)
  const r = (await db.query(
    `INSERT INTO document_fills (office_id, client_id, document_id, source_document_id, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (document_id) WHERE status IN ('queued', 'processing') DO NOTHING RETURNING id`,
    [staff.officeId, d.client_id, d.id, src.id, staff.id],
  )).rows[0]
  if (!r) {
    const active = (await db.query("SELECT id FROM document_fills WHERE document_id = $1 AND status IN ('queued', 'processing')", [d.id])).rows[0]
    return { id: active.id, created: false }
  }
  await audit(db, staff, staff.officeId, 'document.fill', { clientId: d.client_id, documentId: d.id }, { sourceDocumentId: src.id })
  return { id: r.id, created: true }
}

/** 書類のいちばん新しい仕事。まだ頼んでいなければ null */
export async function latestFill(db: Q, officeId: string, documentId: string): Promise<{ clientId: string, fill: FillView | null }> {
  const d = await documentAndSource(db, officeId, documentId)
  const r = (await db.query(
    `SELECT f.id, f.status, f.step, coalesce(jsonb_array_length(b.changes), 0) AS changes
     FROM document_fills f LEFT JOIN batches b ON b.id = f.batch_id
     WHERE f.document_id = $1 ORDER BY f.created_at DESC, f.id LIMIT 1`,
    [d.id],
  )).rows[0]
  return {
    clientId: d.client_id,
    fill: r ? { id: r.id, status: r.status, step: r.step, changes: Number(r.changes), sourceName: d.source_name ?? '' } : null,
  }
}

// ---------- worker ----------

export interface ClaimedFill { id: string, officeId: string, clientId: string, documentId: string, sourceDocumentId: string, attempts: number }

/** 仕事を始める印を付ける（期限つき）。同じ仕事が 2 回届いても、2 つ目は null（何もしない） */
export async function claimFill(db: Q, id: string, token: string): Promise<ClaimedFill | null> {
  const r = (await db.query(
    `UPDATE document_fills SET status = 'processing', step = 'read', attempts = attempts + 1, run_token = $2,
       lease_until = now() + interval '20 minutes', updated_at = now()
     WHERE id = $1 AND attempts < $3 AND (status = 'queued' OR (status = 'processing' AND lease_until < now()))
     RETURNING id, office_id, client_id, document_id, source_document_id, attempts`,
    [id, token, MAX_FILL_ATTEMPTS],
  )).rows[0]
  return r ? { id: r.id, officeId: r.office_id, clientId: r.client_id, documentId: r.document_id, sourceDocumentId: r.source_document_id, attempts: Number(r.attempts) } : null
}

/** 長い仕事の間、印の期限を延ばす。画面に出す段も進める（印がまだ自分のものなら） */
export async function touchFill(db: Q, id: string, token: string, step?: FillStep): Promise<boolean> {
  const r = await db.query(
    `UPDATE document_fills SET lease_until = now() + interval '20 minutes', step = coalesce($3, step), updated_at = now()
     WHERE id = $1 AND run_token = $2 AND status = 'processing' AND lease_until > now() RETURNING id`,
    [id, token, step ?? null],
  )
  return r.rows.length > 0
}

/** 終わったとき（applyBatch と同じトランザクションで呼ぶ）。印がもう自分のものでなければ false */
export async function finishFill(db: Q, id: string, token: string, status: 'succeeded' | 'partial', batchId: string | null, steps: Record<string, unknown>): Promise<boolean> {
  const r = await db.query(
    `UPDATE document_fills SET status = $3, step = 'done', batch_id = $4, steps = $5, lease_until = NULL, run_token = NULL, error_kind = NULL, updated_at = now()
     WHERE id = $1 AND run_token = $2 AND status = 'processing' RETURNING id`,
    [id, token, status, batchId, JSON.stringify(steps)],
  )
  return r.rows.length > 0
}

/** 印を自分のものとして止める（applyBatch の前に、同じトランザクションで） */
export async function lockFill(db: Q, id: string, token: string): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM document_fills WHERE id = $1 AND run_token = $2 AND status = 'processing' AND lease_until > now() FOR UPDATE", [id, token])
  return r.rows.length > 0
}

/** 失敗したとき。回数が残っていれば待ちに戻す（見回りかタスクのやり直しが拾う） */
export async function releaseFill(db: Q, id: string, token: string, terminal: boolean, errorKind: string): Promise<void> {
  await db.query(
    'UPDATE document_fills SET status = $3, error_kind = $4, lease_until = NULL, run_token = NULL, updated_at = now() WHERE id = $1 AND run_token = $2',
    [id, token, terminal ? 'failed' : 'queued', errorKind],
  )
}

/** 見回り: 回数を使い切ったものは failed にし、積み損ね（2 分より前から待っている）・止まったものの id を返す */
export async function fillsToRequeue(db: Q): Promise<string[]> {
  await db.query(
    "UPDATE document_fills SET status = 'failed', lease_until = NULL, run_token = NULL, error_kind = coalesce(error_kind, 'AttemptsExhausted'), updated_at = now() WHERE attempts >= $1 AND (status = 'queued' OR (status = 'processing' AND lease_until < now()))",
    [MAX_FILL_ATTEMPTS],
  )
  const r = await db.query(
    `SELECT id FROM document_fills
     WHERE (status = 'queued' AND updated_at < now() - interval '2 minutes') OR (status = 'processing' AND lease_until < now())
     ORDER BY created_at LIMIT 20`,
  )
  return r.rows.map((x) => x.id)
}
