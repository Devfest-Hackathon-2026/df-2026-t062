// 様式の取り込み（form_imports）の読み書き。api（責任者の form.manage・サイト管理者の site.manage）と worker が使う。
// docs/再設計/13_DB設計.md の form_imports・PDF の置き場。状態は queued → processing → succeeded／failed／matched。
import { createHash } from 'node:crypto'
import type { Bindings } from '../core/binding.ts'
import { contentOf, importPdfPath, type FormPage, type TemplateSlot } from '../core/form.ts'
import { tx, type Db } from './pool.ts'
import { BadRequest, NotFound } from './repo.ts'

/** どこの様式か。officeId が null なら全体の様式（サイト管理者が上げる） */
export interface ImportScope { officeId: string | null }

export type ImportStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'matched'

export interface FormImportView {
  id: string
  kind: string
  status: ImportStatus
  /** PDF が置き場に届いたのを確かめたか（false の間は変換しない） */
  uploaded: boolean
  errorKind: string | null
  /** できた下書きの版。matched なら、同じと分かった全体の様式の版 */
  versionId: string | null
  /** 変換が自信のない欄（印字欄の名前と理由） */
  review: { slot: string, reason: string }[]
  createdAt: string
  updatedAt: string
}

/** 上げてよい PDF の大きさ（worker/form-import/index.ts の importPdf の既定と同じ 20MB） */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024
/** 変換を始めた回数の上限。使い切ったら failed */
export const MAX_IMPORT_ATTEMPTS = 3
/** 失敗した・送るのをやめた PDF を消すまでの日数（13_DB設計.md の未決。おすすめの 7 日） */
export const IMPORT_RETENTION_DAYS = 7

const COLUMNS = 'id, kind, status, uploaded_at, error_kind, version_id, review, created_at, updated_at'
const view = (r: Record<string, unknown>): FormImportView => ({
  id: r.id as string, kind: r.kind as string, status: r.status as ImportStatus, uploaded: r.uploaded_at !== null,
  errorKind: (r.error_kind as string | null) ?? null, versionId: (r.version_id as string | null) ?? null,
  review: r.review as FormImportView['review'],
  createdAt: (r.created_at as Date).toISOString(), updatedAt: (r.updated_at as Date).toISOString(),
})

// ---------- api ----------

export async function createImport(db: Db, scope: ImportScope, kind: string, createdBy: string | null): Promise<FormImportView> {
  // 事業所は、全体の種類か自分の事業所の種類だけ。全体の様式（サイト管理者）は全体の種類だけ（#153）
  const k = (await db.query('SELECT office_id, retired_at FROM form_kinds WHERE key = $1', [kind])).rows[0]
  if (!k || (k.office_id !== null && k.office_id !== scope.officeId) || k.retired_at !== null) throw new BadRequest('書類の種類がありません')
  const r = await db.query(`INSERT INTO form_imports (office_id, kind, created_by) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`, [scope.officeId, kind, createdBy])
  return view(r.rows[0])
}

/** ほかの事業所の取り込み（全体の様式なら事業所のもの、事業所なら全体とほかの事業所のもの）は「無い」 */
export async function getImport(db: Db, scope: ImportScope, id: string): Promise<FormImportView> {
  const r = (await db.query(`SELECT ${COLUMNS} FROM form_imports WHERE id = $1 AND office_id IS NOT DISTINCT FROM $2`, [id, scope.officeId])).rows[0]
  if (!r) throw new NotFound(id)
  return view(r)
}

export async function listImports(db: Db, scope: ImportScope, limit = 50): Promise<FormImportView[]> {
  const r = await db.query(`SELECT ${COLUMNS} FROM form_imports WHERE office_id IS NOT DISTINCT FROM $1 ORDER BY created_at DESC, id LIMIT $2`, [scope.officeId, limit])
  return r.rows.map(view)
}

/**
 * 置き場に PDF が届いたのを確かめて、変換を待つ状態にする（何度呼んでも同じ）。届いていなければ null。
 * 大きすぎる PDF は、変換に回さずに failed（too_large）にする（worker が大きなファイルを読まないように）
 */
export async function markUploaded(
  db: Db, scope: ImportScope, id: string, uploadedSize: (path: string) => Promise<number | null>, maxBytes: number,
): Promise<FormImportView | null> {
  return tx(db, async (c) => {
    const r = (await c.query(`SELECT ${COLUMNS} FROM form_imports WHERE id = $1 AND office_id IS NOT DISTINCT FROM $2 FOR UPDATE`, [id, scope.officeId])).rows[0]
    if (!r) throw new NotFound(id)
    if (r.uploaded_at !== null) return view(r)
    const size = await uploadedSize(importPdfPath(id, scope.officeId))
    if (!size) return null
    const tooLarge = size > maxBytes
    const u = await c.query(
      `UPDATE form_imports SET uploaded_at = now(), updated_at = now(),
         status = CASE WHEN $2 THEN 'failed' ELSE status END, error_kind = CASE WHEN $2 THEN 'too_large' ELSE error_kind END
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, tooLarge],
    )
    return view(u.rows[0])
  })
}

// ---------- worker ----------

export interface ClaimedImport { id: string, officeId: string | null, kind: string, attempts: number }

/** 変換を始める印を付ける（期限つき）。同じ取り込みが 2 回届いても、2 つ目は null（何もしない） */
export async function claimImport(db: Db, id: string, token: string): Promise<ClaimedImport | null> {
  const r = (await db.query(
    `UPDATE form_imports SET status = 'processing', attempts = attempts + 1, run_token = $2,
       lease_until = now() + interval '20 minutes', updated_at = now()
     WHERE id = $1 AND uploaded_at IS NOT NULL AND attempts < $3
       AND (status = 'queued' OR (status = 'processing' AND lease_until < now()))
     RETURNING id, office_id, kind, attempts`,
    [id, token, MAX_IMPORT_ATTEMPTS],
  )).rows[0]
  return r ? { id: r.id, officeId: r.office_id, kind: r.kind, attempts: Number(r.attempts) } : null
}

/** 長い変換の間、印の期限を延ばす。もう自分の印でなければ false */
export async function extendImportLease(db: Db, id: string, token: string): Promise<boolean> {
  const r = await db.query(
    "UPDATE form_imports SET lease_until = now() + interval '20 minutes' WHERE id = $1 AND run_token = $2 AND status = 'processing' AND lease_until > now() RETURNING id",
    [id, token],
  )
  return r.rows.length > 0
}

/** 登録済みの全体の様式（使う版）の元の PDF のハッシュ → 版。同じ PDF なら変換しない（matched） */
export async function knownGlobalPdfs(db: Db): Promise<Map<string, { versionId: string, kind: string }[]>> {
  const r = await db.query(
    `SELECT v.id, v.base_pdf_sha256, t.kind FROM form_template_versions v JOIN form_templates t ON t.id = v.template_id
     WHERE t.office_id IS NULL AND v.status = 'published' ORDER BY t.kind, v.id`,
  )
  const out = new Map<string, { versionId: string, kind: string }[]>()
  for (const row of r.rows) out.set(row.base_pdf_sha256, [...(out.get(row.base_pdf_sha256) ?? []), { versionId: row.id, kind: row.kind }])
  return out
}

export type ImportOutcome =
  | { status: 'matched', basePdfSha256: string, versionId: string }
  | { status: 'failed', basePdfSha256: string | null, errorKind: string }

/** matched・failed で終える。もう自分の印でなければ false（ほかの実行が終えた・期限が切れた） */
export async function finishImport(db: Db, id: string, token: string, o: ImportOutcome): Promise<boolean> {
  const r = await db.query(
    `UPDATE form_imports SET status = $3, base_pdf_sha256 = $4, version_id = $5, error_kind = $6,
       lease_until = NULL, run_token = NULL, updated_at = now()
     WHERE id = $1 AND run_token = $2 AND status = 'processing' RETURNING id`,
    [id, token, o.status, o.basePdfSha256, o.status === 'matched' ? o.versionId : null, o.status === 'failed' ? o.errorKind : null],
  )
  return r.rows.length > 0
}

export interface DraftInput {
  schemas: TemplateSlot[][]
  bindings: Bindings
  pages: FormPage[]
  localFields: unknown[]
  review: { slot: string, reason: string }[]
}

/**
 * 下書きの版を作って succeeded で終える（1 つのトランザクション）。もう自分の印でなければ何もせず null。
 * 様式は種類×事業所で 1 つ（なければ作る）。版の番号はその様式の続き。状態は draft（書類からは指せない）
 */
export async function finishWithDraft(db: Db, claimed: ClaimedImport, token: string, basePdfSha256: string, d: DraftInput): Promise<string | null> {
  return tx(db, async (c) => {
    const mine = (await c.query("SELECT id FROM form_imports WHERE id = $1 AND run_token = $2 AND status = 'processing' FOR UPDATE", [claimed.id, token])).rows[0]
    if (!mine) return null
    const t = (await c.query(
      `INSERT INTO form_templates (kind, name, title, office_id) SELECT k.key, k.name, k.name, $2 FROM form_kinds k WHERE k.key = $1
       ON CONFLICT ON CONSTRAINT form_templates_scope DO UPDATE SET kind = EXCLUDED.kind RETURNING id`,
      [claimed.kind, claimed.officeId],
    )).rows[0]
    await c.query('SELECT id FROM form_templates WHERE id = $1 FOR UPDATE', [t.id])
    const version = Number((await c.query('SELECT coalesce(max(version), 0) AS v FROM form_template_versions WHERE template_id = $1', [t.id])).rows[0].v) + 1
    const contentSha = createHash('sha256').update(contentOf({ kind: claimed.kind, ...d })).digest('hex')
    const v = (await c.query(
      `INSERT INTO form_template_versions (template_id, version, schemas, bindings, pages, local_fields, content_sha, base_pdf_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [t.id, version, JSON.stringify(d.schemas), JSON.stringify(d.bindings), JSON.stringify(d.pages), JSON.stringify(d.localFields), contentSha, basePdfSha256],
    )).rows[0]
    await c.query(
      `UPDATE form_imports SET status = 'succeeded', base_pdf_sha256 = $2, version_id = $3, review = $4, error_kind = NULL,
         lease_until = NULL, run_token = NULL, updated_at = now() WHERE id = $1`,
      [claimed.id, basePdfSha256, v.id, JSON.stringify(d.review)],
    )
    return v.id as string
  })
}

/** 置き場か DB の誤りで止まった。回数が残っていれば queued に戻し（見回りか Cloud Tasks がやり直す）、使い切ったら failed（internal） */
export async function releaseImport(db: Db, id: string, token: string, terminal: boolean): Promise<void> {
  await db.query(
    `UPDATE form_imports SET status = $3, error_kind = $4, lease_until = NULL, run_token = NULL, updated_at = now()
     WHERE id = $1 AND run_token = $2 AND status = 'processing'`,
    [id, token, terminal ? 'failed' : 'queued', terminal ? 'internal' : null],
  )
}

export async function markUploadDeleted(db: Db, id: string): Promise<void> {
  await db.query('UPDATE form_imports SET upload_deleted_at = now() WHERE id = $1 AND upload_deleted_at IS NULL', [id])
}

/**
 * 見回り: 回数を使い切ったものを failed にし、積み直すもの（積み損ね・期限の切れた変換）を返す。
 * 送り終わっていないもの（uploaded_at が空）は積まない
 */
export async function importsToRequeue(db: Db, limit = 20): Promise<string[]> {
  await db.query(
    `UPDATE form_imports SET status = 'failed', error_kind = coalesce(error_kind, 'internal'), lease_until = NULL, run_token = NULL, updated_at = now()
     WHERE attempts >= $1 AND (status = 'queued' OR (status = 'processing' AND lease_until < now()))`,
    [MAX_IMPORT_ATTEMPTS],
  )
  const r = await db.query(
    `SELECT id FROM form_imports
     WHERE uploaded_at IS NOT NULL AND ((status = 'queued' AND updated_at < now() - interval '2 minutes') OR (status = 'processing' AND lease_until < now()))
     ORDER BY created_at LIMIT $1`,
    [limit],
  )
  return r.rows.map((row) => row.id as string)
}

/**
 * 見回り: 消す上げたままの PDF。変換が済んだもの（succeeded・matched）はすぐ、
 * 失敗したもの・送るのをやめたものは IMPORT_RETENTION_DAYS 日たってから（失敗を調べられるように）
 */
export async function uploadsToDelete(db: Db, limit = 50): Promise<{ id: string, officeId: string | null }[]> {
  const r = await db.query(
    `SELECT id, office_id FROM form_imports
     WHERE upload_deleted_at IS NULL AND (
       status IN ('succeeded', 'matched')
       OR (status = 'failed' AND updated_at < now() - make_interval(days => $1))
       OR (uploaded_at IS NULL AND created_at < now() - make_interval(days => $1)))
     ORDER BY created_at LIMIT $2`,
    [IMPORT_RETENTION_DAYS, limit],
  )
  return r.rows.map((row) => ({ id: row.id as string, officeId: (row.office_id as string | null) ?? null }))
}
