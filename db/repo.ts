import { validDiagramUpdate } from '../core/diagram/fields.ts'
// DB の読み書き。api と worker が共通に使う。どの関数も office_id で絞る。
import { planBatch, sameValue, type BatchPlan, type Cite, type CurrentField } from '../core/apply-batch.ts'
import { saveOneHunk } from '../core/diff.ts'
import { slotPages, type FormKind } from '../core/form.ts'
import type { DocumentSource } from '../core/document-input.ts'
import type { SurveySource } from '../core/survey-import.ts'
import { countRequired } from '../core/required.ts'
import { fieldDict } from '../core/dictionary.ts'
import { validValue } from '../core/schema.ts'
import { applyChanges, editSlot, slotKeys, type Values, type Who } from '../core/slots.ts'
import { loadFormDef, publishedVersionId } from './forms.ts'
import { kindOf, primaryKind, visibleKind } from './kinds.ts'
import { tx, type Db, type Tx } from './pool.ts'
import { writeBusinessAudit, type AuditContext, type AuditOutcome } from './audit.ts'
import { setRecordingRetentionOnComplete } from './recording-retention.ts'

type Q = Db | Tx

export interface Staff { id: string, officeId: string, name: string, email: string | null, role: string, officeName: string }

const auditContexts = new WeakMap<Staff, AuditContext>()

export function auditContextOf(staff: Staff | null | undefined): AuditContext | undefined {
  return staff ? auditContexts.get(staff) : undefined
}

export interface FieldRow { value: unknown, aiValue: unknown, by: Who, batchId: string | null, updatedAt: string, valueVersion?: string, reviewedAt?: string, reviewedBy?: string, surveySource?: SurveySource, documentSource?: DocumentSource }
export interface SavedRow { value: unknown, by: Who }

export interface DocumentView {
  id: string
  clientId: string
  kind: FormKind
  /** 書類が使う様式の版（GET /api/form-versions/:id） */
  formVersionId: string
  fields: Record<string, FieldRow>
  saved: Record<string, SavedRow>
  rev: number
  confirmation?: {rev:number;confirmedAt:string;confirmedBy:string}
  batches: { id: string, kind: string, label: string, createdAt: string, changes: number, kept: number }[]
}

export class NotFound extends Error {}
export class BadRequest extends Error {}
/** 画面が見ていた値・様式の版が、サーバーで変わっていた（409。画面は読み直す） */
export class Conflict extends Error {}
/** 役割では許していても、その相手にはできない操作（403。責任者が自分を止めるなど） */
export class Forbidden extends Error {}

// ---------- 職員 ----------

/** ログインした職員。止めた職員（disabled_at あり）は null（リクエストのたびに DB から読むので、止めたらすぐ効く） */
export async function staffByAuth(db: Q, authUid: string, email?: string, allowEmailMatch = false, auditContext?: AuditContext): Promise<Staff | null> {
  const sql = `SELECT s.id, s.office_id, s.name, s.email, s.role, o.name AS office_name
               FROM staff s JOIN offices o ON o.id = s.office_id
               WHERE (s.auth_uid = $1 ${allowEmailMatch ? 'OR (s.email IS NOT NULL AND s.email = $2)' : ''}) AND s.disabled_at IS NULL LIMIT 1`
  const r = await db.query(sql, allowEmailMatch ? [authUid, email ?? ''] : [authUid])
  const s = r.rows[0]
  if (!s) return null
  const staff = { id: s.id, officeId: s.office_id, name: s.name, email: s.email, role: s.role, officeName: s.office_name }
  if (auditContext) auditContexts.set(staff, auditContext)
  return staff
}

export async function audit(
  db: Q,
  staff: Staff | null,
  officeId: string | null,
  action: string,
  ids: { clientId?: string, documentId?: string },
  detail: Record<string, unknown> = {},
  context: AuditContext & { outcome?: AuditOutcome } = {},
) {
  await writeBusinessAudit(db, {
    officeId,
    actorStaffId: staff?.id ?? null,
    action,
    ids,
    detail,
    outcome: context.outcome,
    context: { ...auditContextOf(staff), ...context },
  })
}

// ---------- 利用者 ----------

export interface ClientSummary {
  id: string
  name: string
  sex: string | null
  status: string
  careLevel: string | null
  required: { filled: number, total: number }
  nextVisitAt: string | null
  isNew: boolean
  updatedAt: string
  /** 主な書類（form_kinds.is_primary）の id */
  documentId: string | null
}

/** 主な書類（form_kinds.is_primary）の値。利用者一覧の要介護度・入力の進み具合はここから出す */
async function valuesOf(db: Q, officeId: string, clientIds: string[]) {
  const r = await db.query(
    `SELECT f.client_id, f.key, f.value FROM field_values f
     JOIN documents d ON d.id = f.document_id
     JOIN form_kinds k ON k.key = d.kind AND k.is_primary
     WHERE f.office_id = $1 AND f.client_id = ANY($2::uuid[])`,
    [officeId, clientIds],
  )
  const out = new Map<string, Record<string, unknown>>()
  for (const row of r.rows) {
    const m = out.get(row.client_id) ?? {}
    m[row.key] = row.value
    out.set(row.client_id, m)
  }
  return out
}

export async function listClients(db: Q, officeId: string, opts: { q?: string, sort?: 'updated' | 'name' } = {}): Promise<ClientSummary[]> {
  const q = opts.q?.trim()
  const r = await db.query(
    `SELECT c.id, c.name, c.status, c.next_visit_at, c.updated_at, d.id AS document_id,
            EXISTS (SELECT 1 FROM revisions v WHERE v.document_id = d.id) AS has_rev
     FROM clients c LEFT JOIN documents d ON d.client_id = c.id AND d.kind = (SELECT key FROM form_kinds WHERE is_primary)
     WHERE c.office_id = $1 AND c.archived_at IS NULL ${q ? 'AND c.name ILIKE $2' : ''}
     ORDER BY ${opts.sort === 'name' ? 'c.name ASC' : 'c.updated_at DESC'}`,
    q ? [officeId, `%${q}%`] : [officeId],
  )
  const values = await valuesOf(db, officeId, r.rows.map((x) => x.id))
  const { required } = await primaryKind(db)
  return r.rows.map((c) => {
    const v = values.get(c.id) ?? {}
    return {
      id: c.id,
      name: c.name,
      sex: (v['person.sex'] as string) ?? null,
      status: c.status,
      careLevel: (v['cert.careLevel'] as string) ?? null,
      required: countRequired(v, required),
      nextVisitAt: c.next_visit_at ? new Date(c.next_visit_at).toISOString() : null,
      isNew: !c.has_rev && Object.keys(v).filter((k) => k !== 'person.name' && k !== 'person.sex').length === 0,
      updatedAt: new Date(c.updated_at).toISOString(),
      documentId: c.document_id,
    }
  })
}

export async function createClient(db: Db, staff: Staff, input: { name: string, sex?: '男' | '女' | null, status?: string }) {
  return tx(db, async (c) => {
    const client = (await c.query(
      'INSERT INTO clients (office_id, name, status, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [staff.officeId, input.name, input.status ?? '在宅', staff.id],
    )).rows[0]
    // 主な書類（form_kinds.is_primary）も一緒に作る
    const { key: kind } = await primaryKind(c)
    const version = await publishedVersionId(c, staff.officeId, kind)
    const doc = (await c.query(
      'INSERT INTO documents (office_id, client_id, kind, template_version_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [staff.officeId, client.id, kind, version, staff.id],
    )).rows[0]
    const initial: [string, unknown][] = [['person.name', input.name]]
    if (input.sex) initial.push(['person.sex', input.sex])
    for (const [key, value] of initial) {
      await c.query(
        "INSERT INTO field_values (office_id, client_id, document_id, key, value, by, updated_by) VALUES ($1,$2,$3,$4,$5,'cm',$6)",
        [staff.officeId, client.id, doc.id, key, JSON.stringify(value), staff.id],
      )
      await c.query("INSERT INTO document_saved (document_id, key, value, by) VALUES ($1,$2,$3,'cm')", [doc.id, key, JSON.stringify(value)])
    }
    await audit(c, staff, staff.officeId, 'client.create', { clientId: client.id })
    return { id: client.id as string, documentId: doc.id as string }
  })
}

export async function getClient(db: Q, officeId: string, clientId: string) {
  const c = (await db.query('SELECT id, name, status, next_visit_at FROM clients WHERE id = $1 AND office_id = $2 AND archived_at IS NULL', [clientId, officeId])).rows[0]
  if (!c) throw new NotFound()
  const docs = (await db.query('SELECT id, kind, template_version_id FROM documents WHERE client_id = $1 AND office_id = $2 ORDER BY created_at', [clientId, officeId])).rows
  const values = (await valuesOf(db, officeId, [clientId])).get(clientId) ?? {}
  const { required } = await primaryKind(db)
  return {
    id: c.id as string,
    name: c.name as string,
    status: c.status as string,
    nextVisitAt: c.next_visit_at ? new Date(c.next_visit_at).toISOString() : null,
    documents: docs.map((d) => ({ id: d.id as string, kind: d.kind as FormKind, formVersionId: d.template_version_id as string })),
    required: countRequired(values, required),
  }
}

// ---------- 書類 ----------

export async function lockDocument(c: Tx, officeId: string, documentId: string) {
  const d = (await c.query('SELECT id, client_id, kind, template_version_id FROM documents WHERE id = $1 AND office_id = $2 FOR UPDATE', [documentId, officeId])).rows[0]
  if (!d) throw new NotFound()
  return { id: d.id as string, clientId: d.client_id as string, kind: d.kind as FormKind, versionId: d.template_version_id as string }
}

/** 書類の今の値（どの値も、どれか 1 つの書類に属する） */
export async function readFields(db: Q, documentId: string): Promise<Record<string, FieldRow>> {
  const r = await db.query(
    'SELECT key, value, ai_value, by, batch_id, updated_at, cite, reviewed_at, reviewed_by, value_version FROM field_values WHERE document_id = $1',
    [documentId],
  )
  const out: Record<string, FieldRow> = {}
  for (const row of r.rows) {
    out[row.key] = { valueVersion:row.value_version, value: row.value, aiValue: row.ai_value, by: row.by, batchId: row.batch_id, updatedAt: new Date(row.updated_at).toISOString(),
      ...(row.reviewed_at ? {reviewedAt:new Date(row.reviewed_at).toISOString(),reviewedBy:row.reviewed_by} : {}),
      ...(row.cite?.kind === 'survey-import' ? { surveySource: row.cite as SurveySource } : {}),
      ...(row.cite?.kind === 'document-input' ? { documentSource: row.cite as DocumentSource } : {}) }
  }
  return out
}

async function readSaved(db: Q, documentId: string): Promise<Record<string, SavedRow>> {
  const r = await db.query('SELECT key, value, by FROM document_saved WHERE document_id = $1', [documentId])
  return Object.fromEntries(r.rows.map((x) => [x.key, { value: x.value, by: x.by }]))
}

export async function getDocument(db: Q, officeId: string, documentId: string): Promise<DocumentView> {
  const d = (await db.query('SELECT id, client_id, kind, template_version_id FROM documents WHERE id = $1 AND office_id = $2', [documentId, officeId])).rows[0]
  if (!d) throw new NotFound()
  const [fields, saved, rev, batches, confirmation] = await Promise.all([
    readFields(db, d.id),
    readSaved(db, d.id),
    db.query('SELECT coalesce(max(rev), 0) AS rev FROM revisions WHERE document_id = $1', [d.id]),
    db.query('SELECT id, kind, label, created_at, jsonb_array_length(changes) AS n, jsonb_array_length(kept) AS k FROM batches WHERE document_id = $1 ORDER BY created_at DESC LIMIT 10', [d.id]),
    db.query('SELECT rev,confirmed_at,confirmed_by FROM document_confirmations WHERE document_id=$1 ORDER BY rev DESC LIMIT 1',[d.id]),
  ])
  return {
    id: d.id,
    clientId: d.client_id,
    kind: d.kind,
    formVersionId: d.template_version_id,
    fields,
    saved,
    rev: Number(rev.rows[0].rev),
    ...(confirmation.rows[0] ? {confirmation:{rev:Number(confirmation.rows[0].rev),confirmedAt:new Date(confirmation.rows[0].confirmed_at).toISOString(),confirmedBy:confirmation.rows[0].confirmed_by}} : {}),
    batches: batches.rows.map((b) => ({ id: b.id, kind: b.kind, label: b.label, createdAt: new Date(b.created_at).toISOString(), changes: Number(b.n), kept: Number(b.k) })),
  }
}

/** 利用者の録音の文字起こし（古い順）。チャットの根拠に使う */
export async function clientTranscripts(db: Q, officeId: string, clientId: string): Promise<{ id: string, recordedAt: string, utterances: { id: string, speaker: string, person?: string | null, text: string }[] }[]> {
  const r = await db.query(
    `SELECT r.id, r.recorded_at, t.utterances FROM transcripts t JOIN recordings r ON r.id = t.recording_id
     WHERE t.office_id = $1 AND t.client_id = $2
       AND r.intermediate_delete_status NOT IN ('deleted', 'deleting')
       AND (r.intermediate_expires_at > now() OR r.retention_hold OR r.retention_hold_target)
     ORDER BY r.recorded_at`,
    [officeId, clientId],
  )
  return r.rows.map((x) => ({ id: String(x.id), recordedAt: new Date(x.recorded_at).toISOString(), utterances: x.utterances }))
}

/** 管理者が保持期限と保全状態を確認するための録音一覧。音声の中身や保存先は返さない。 */
export interface RecordingRetentionListItem {
  id: string
  recordedAt: string
  sourceExpiresAt: string
  sourcePurgeExpectedAt: string | null
  sourceDeleteStatus: string
  sourceDeletedAt: string | null
  intermediateExpiresAt: string
  intermediateDeleteStatus: string
  intermediateDeletedAt: string | null
  retentionHold: boolean
  retentionHoldTarget: boolean
  retentionHoldSyncStatus: string
  retentionHoldUntil: string | null
  retentionHoldReasonCode: string | null
}

export async function listRecordingRetentions(db: Q, officeId: string, clientId: string): Promise<RecordingRetentionListItem[]> {
  const r = await db.query(
    `SELECT id, recorded_at, source_expires_at, source_purge_expected_at, source_delete_status, source_deleted_at,
            intermediate_expires_at, intermediate_delete_status, intermediate_deleted_at,
            retention_hold, retention_hold_target, retention_hold_sync_status,
            retention_hold_until, retention_hold_reason_code
       FROM recordings
      WHERE office_id = $1 AND client_id = $2
      ORDER BY recorded_at DESC, id DESC`,
    [officeId, clientId],
  )
  return r.rows.map((row) => ({
    id: String(row.id),
    recordedAt: new Date(row.recorded_at).toISOString(),
    sourceExpiresAt: new Date(row.source_expires_at).toISOString(),
    sourcePurgeExpectedAt: row.source_purge_expected_at ? new Date(row.source_purge_expected_at).toISOString() : null,
    sourceDeleteStatus: String(row.source_delete_status),
    sourceDeletedAt: row.source_deleted_at ? new Date(row.source_deleted_at).toISOString() : null,
    intermediateExpiresAt: new Date(row.intermediate_expires_at).toISOString(),
    intermediateDeleteStatus: String(row.intermediate_delete_status),
    intermediateDeletedAt: row.intermediate_deleted_at ? new Date(row.intermediate_deleted_at).toISOString() : null,
    retentionHold: Boolean(row.retention_hold),
    retentionHoldTarget: Boolean(row.retention_hold_target),
    retentionHoldSyncStatus: String(row.retention_hold_sync_status),
    retentionHoldUntil: row.retention_hold_until ? new Date(row.retention_hold_until).toISOString() : null,
    retentionHoldReasonCode: row.retention_hold_reason_code ? String(row.retention_hold_reason_code) : null,
  }))
}

/** 同じ利用者のほかの書類（書き方の相談で AI が読む）。同じ事業所の、同じ利用者のものだけ */
export async function otherDocuments(db: Q, officeId: string, clientId: string, exceptId: string): Promise<DocumentView[]> {
  const r = await db.query('SELECT id FROM documents WHERE office_id = $1 AND client_id = $2 AND id <> $3 ORDER BY created_at', [officeId, clientId, exceptId])
  return Promise.all(r.rows.map((x) => getDocument(db, officeId, x.id as string)))
}

/** 書類の欄として持てる key（その書類の様式の版の印字欄が読む key） */
async function allowedKeys(db: Q, versionId: string): Promise<Set<string>> {
  return new Set((await loadFormDef(db, versionId)).keys)
}

export async function writeField(c: Tx, officeId: string, clientId: string, documentId: string, key: string, value: unknown, by: Who, staffId: string | null, extra: { aiValue?: unknown, batchId?: string, cite?: unknown } = {}) {
  const docId = documentId
  const prev = (await c.query(
    'SELECT value, by, batch_id, reviewed_at FROM field_values WHERE document_id = $1 AND key = $2',
    [docId, key],
  )).rows[0]
  if (by === 'ai' && prev?.reviewed_at && !sameValue(prev.value,value)) throw new Conflict('reviewed_field')
  if (prev) {
    await c.query(
      'INSERT INTO field_history (office_id, client_id, document_id, key, value, by, batch_id, changed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [officeId, clientId, docId, key, JSON.stringify(prev.value), prev.by, prev.batch_id, staffId],
    )
  }
  if (value === null || value === undefined) {
    await c.query('DELETE FROM field_values WHERE document_id = $1 AND key = $2', [docId, key])
    return
  }
  await c.query(
    `INSERT INTO field_values (office_id, client_id, document_id, key, value, ai_value, by, batch_id, cite, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     ON CONFLICT ON CONSTRAINT field_values_unique DO UPDATE SET
       value_version = gen_random_uuid(),
       reviewed_at = CASE WHEN field_values.value = EXCLUDED.value THEN field_values.reviewed_at ELSE NULL END,
       reviewed_by = CASE WHEN field_values.value = EXCLUDED.value THEN field_values.reviewed_by ELSE NULL END,
       value = EXCLUDED.value,
       ai_value = coalesce(EXCLUDED.ai_value, field_values.ai_value),
       by = EXCLUDED.by,
       batch_id = coalesce(EXCLUDED.batch_id, field_values.batch_id),
       cite = CASE
         WHEN field_values.cite->>'kind' IN ('survey-import', 'document-input') THEN EXCLUDED.cite
         ELSE coalesce(EXCLUDED.cite, field_values.cite)
       END,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [officeId, clientId, docId, key, JSON.stringify(value), extra.aiValue === undefined ? null : JSON.stringify(extra.aiValue), by, extra.batchId ?? null, extra.cite === undefined ? null : JSON.stringify(extra.cite), staffId],
  )
}

/** 書類の欄の値だけ（by などを除く） */
const plainValues = (fields: Record<string, FieldRow>): Values => Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.value]))

/** 直したあと: 利用者の名前（主な書類の氏名を直したときだけ）・更新日時、記録 */
async function afterEdit(c: Tx, staff: Staff, d: { id: string, clientId: string, kind: FormKind }, keys: string[], values: Values) {
  if (keys.includes('person.name') && typeof values['person.name'] === 'string' && values['person.name'].trim()) {
    await c.query(
      'UPDATE clients SET name = $1 WHERE id = $2 AND EXISTS (SELECT 1 FROM form_kinds WHERE key = $3 AND is_primary)',
      [values['person.name'].trim(), d.clientId, d.kind],
    )
  }
  await c.query('UPDATE clients SET updated_at = now() WHERE id = $1', [d.clientId])
  await c.query('UPDATE documents SET updated_at = now() WHERE id = $1', [d.id])
  await audit(c, staff, staff.officeId, 'document.edit', { clientId: d.clientId, documentId: d.id }, { fields: keys.length })
}

export interface FieldChange {
  key: string
  value: unknown
  /** 画面がこの直しの元にした値（null は空）。サーバーの今の値と違えば Conflict（409） */
  base: unknown
  mode?: 'edit' | 'revert'
  surveySource?: SurveySource
  documentSource?: DocumentSource
}

/**
 * 欄の値をそのまま変える直し（差分の欄の文章、前の文に戻す）。by=cm にする。
 * 欄は書類の様式の版が読むものだけ。値の型は版の欄の辞書（fields.json と、その様式だけの欄）で確かめる（違えば BadRequest）。
 * 「前の文に戻す」（mode=revert）で保存した値と同じに戻ったときは、保存したときの by に戻す。
 * 画面が見ていた値（base）とサーバーの今の値が違えば、何も変えずに Conflict（AI が書いたばかりの値を上書きしない）。
 */
export async function patchFields(db: Db, staff: Staff, documentId: string, changes: FieldChange[], run: <T>(fn: (c: Tx) => Promise<T>) => Promise<T> = (fn) => tx(db, fn)) {
  return run(async (c) => {
    const d = await lockDocument(c, staff.officeId, documentId)
    const form = await loadFormDef(c, d.versionId)
    const allowed = new Set(form.keys)
    const dict = fieldDict(form.localFields)
    const saved = await readSaved(c, d.id)
    const fields = await readFields(c, d.id)
    for (const ch of changes) {
      if (!allowed.has(ch.key)) throw new BadRequest(`この書類にない欄です: ${ch.key}`)
      if (!validValue(ch.key, ch.value ?? null, {}, dict)) throw new BadRequest(`値の形が違います: ${ch.key}`)
      if (!sameValue(fields[ch.key]?.value ?? null, ch.base ?? null)) throw new Conflict(ch.key)
      if (!validDiagramUpdate(ch.key, ch.value, fields[ch.key]?.value ?? null)) throw new BadRequest('図の版または内容が正しくありません')
      if (ch.surveySource && sameValue(ch.base, null) && !sameValue(saved[ch.key]?.value, null)) throw new Conflict(ch.key)
    }
    for (const ch of changes) {
      const back = ch.mode === 'revert' && saved[ch.key] && sameValue(saved[ch.key].value, ch.value)
      const cur = fields[ch.key]
      const by: Who = back ? saved[ch.key].by : ch.mode === 'revert' && cur ? cur.by : 'cm'
      await writeField(c, staff.officeId, d.clientId, d.id, ch.key, ch.value, by, staff.id, { cite: ch.documentSource ?? ch.surveySource })
    }
    const values = applyChanges(plainValues(fields), changes.map((ch) => ({ key: ch.key, value: ch.value })))
    await afterEdit(c, staff, d, changes.map((ch) => ch.key), values)
    return {}
  })
}

export interface SlotEdit { slot: string, text: string }
export interface SlotEditResult { slot: string, reason?: string }

/**
 * 用紙の印字欄の直し。書類の行を止め、その時点の値に、様式の版の対応（共通の仕組み）で 1 つずつ当てる。
 * 当てられない直しは理由を返す（ほかの直しは当てる）。画面の様式の版が書類の版と違えば Conflict。
 */
export async function applySlotEdits(db: Db, staff: Staff, documentId: string, formVersionId: string, edits: SlotEdit[],
  checkEdits?: (db: Tx, keys: string[]) => Promise<void>) {
  return tx(db, async (c) => {
    const d = await lockDocument(c, staff.officeId, documentId)
    if (d.versionId !== formVersionId) throw new Conflict('form_version')
    const form = await loadFormDef(c, d.versionId)
    // 実際の様式の版が一致することを確認し、書類をロックしたまま編集先を検証する。
    await checkEdits?.(c, edits.flatMap((edit) => form.bindings[edit.slot] ? [form.bindings[edit.slot].ref.key] : []))
    const fields = await readFields(c, d.id)
    const before = plainValues(fields)
    let values = before
    const results: SlotEditResult[] = []
    for (const e of edits) {
      if (!form.bindings[e.slot]) throw new BadRequest(`この様式にない欄です: ${e.slot}`)
      const r = editSlot(form, values, e.slot, e.text)
      if ('reason' in r) { results.push({ slot: e.slot, reason: r.reason }); continue }
      values = applyChanges(values, r.changes)
      results.push({ slot: e.slot })
    }
    const changed = [...new Set([...Object.keys(before), ...Object.keys(values)])].filter((k) => !sameValue(before[k] ?? null, values[k] ?? null))
    for (const k of changed) await writeField(c, staff.officeId, d.clientId, d.id, k, values[k] ?? null, 'cm', staff.id)
    if (changed.length) await afterEdit(c, staff, d, changed, values)
    return { results }
  })
}

export type SaveRequest =
  | { scope: 'document' }
  | { scope: 'page', page: number }
  | { scope: 'hunk', key: string, hunkIndex: number }

/** 保存の 3 段。保存した値（document_saved）を更新し、保存した値の全部を版として残す */
export async function saveDocument(db: Db, staff: Staff, documentId: string, req: SaveRequest) {
  return tx(db, (c) => saveDocumentInTx(c, staff, documentId, req))
}

/** 計画版の保存など、ほかの書き込みと同じトランザクションで保存するとき（saveDocument の中身） */
export async function saveDocumentInTx(c: Tx, staff: Staff, documentId: string, req: SaveRequest) {
  const d = await lockDocument(c, staff.officeId, documentId)
  const fields = await readFields(c, d.id)
  const saved = await readSaved(c, d.id)
  const form = await loadFormDef(c, d.versionId)
  const next = new Map<string, SavedRow | null>()

  if (req.scope === 'hunk') {
    const cur = fields[req.key]
    if (!cur || typeof cur.value !== 'string') throw new BadRequest('文章の欄ではありません')
    const before = typeof saved[req.key]?.value === 'string' ? (saved[req.key].value as string) : ''
    next.set(req.key, { value: saveOneHunk(before, cur.value, req.hunkIndex), by: cur.by })
  } else {
    let keys: Set<string>
    if (req.scope === 'document') keys = new Set([...Object.keys(fields), ...Object.keys(saved)])
    else {
      // そのページの印字欄が読む key
      const pages = slotPages(form)
      keys = new Set<string>()
      for (const [slot, p] of pages) {
        if (p !== req.page) continue
        for (const k of slotKeys(form, slot)) keys.add(k)
      }
    }
    for (const k of keys) {
      if (!fields[k] && !saved[k]) continue
      next.set(k, fields[k] ? { value: fields[k].value, by: fields[k].by } : null)
    }
  }

  for (const [k, v] of next) {
    if (v === null) await c.query('DELETE FROM document_saved WHERE document_id = $1 AND key = $2', [d.id, k])
    else {
      await c.query(
        `INSERT INTO document_saved (document_id, key, value, by, saved_at) VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (document_id, key) DO UPDATE SET value = EXCLUDED.value, by = EXCLUDED.by, saved_at = now()`,
        [d.id, k, JSON.stringify(v.value), v.by],
      )
    }
  }
  const all = await readSaved(c, d.id)
  const rev = Number((await c.query('SELECT coalesce(max(rev), 0) + 1 AS rev FROM revisions WHERE document_id = $1', [d.id])).rows[0].rev)
  await c.query(
    'INSERT INTO revisions (office_id, document_id, rev, scope, "values", template_version_id, saved_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [staff.officeId, d.id, rev, req.scope, JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.value]))), d.versionId, staff.id],
  )
  await audit(c, staff, staff.officeId, 'document.save', { clientId: d.clientId, documentId: d.id }, { scope: req.scope, rev, fields: next.size })
  return { rev, savedKeys: next.size }
}

/** 最新の版（PDF を作る元）と、保存したときの様式の版。版がなければ空の値と、書類の今の様式の版 */
export async function latestRevision(db: Q, officeId: string, documentId: string) {
  const r = (await db.query(
    `SELECT v.rev, v."values", v.template_version_id FROM revisions v JOIN documents d ON d.id = v.document_id
     WHERE v.document_id = $1 AND d.office_id = $2 ORDER BY v.rev DESC LIMIT 1`,
    [documentId, officeId],
  )).rows[0]
  if (r) return { rev: Number(r.rev), values: r.values as Record<string, unknown>, formVersionId: r.template_version_id as string }
  const d = (await db.query('SELECT template_version_id FROM documents WHERE id = $1 AND office_id = $2', [documentId, officeId])).rows[0]
  if (!d) throw new NotFound()
  return { rev: 0, values: {} as Record<string, unknown>, formVersionId: d.template_version_id as string }
}

export async function recordExport(db: Q, staff: Staff, documentId: string, rev: number, formVersionId: string, objectPath: string | null) {
  await db.query('INSERT INTO exports (office_id, document_id, revision_rev, template_version_id, object_path, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [staff.officeId, documentId, rev, formVersionId, objectPath, staff.id])
  await audit(db, staff, staff.officeId, 'document.pdf', { documentId }, { rev })
}

// ---------- AI の書き込み（applyBatch） ----------

export interface ApplyInput {
  officeId: string
  documentId: string
  kind: 'recording' | 'copy' | 'seed' | 'fill'
  label: string
  jobId?: string
  /** Worker の今回の実行。ジョブ完了と用紙への反映を同じ transaction で確定する */
  completion?: { token: string, status: 'succeeded' | 'partial', steps: Record<string, unknown>, auditContext?: AuditContext }
  proposed: Record<string, { value: unknown, cite?: Cite }>
  /** プログラムが決める欄の値（1 回目の録音の日をアセスメント実施日にする、など） */
  system?: Record<string, unknown>
}

/**
 * 用紙を変える AI の入口はここだけ。書類の行を止め、今の用紙を読み直し、書き換えの決まりで書く（1 回のトランザクション）。
 * before は反映の瞬間の用紙から取る。
 */
export async function applyBatch(db: Db, input: ApplyInput, run: <T>(fn: (c: Tx) => Promise<T>) => Promise<T> = (fn) => tx(db, fn)): Promise<{ batchId: string | null, plan: BatchPlan }> {
  return run(async (c) => {
    if (input.completion && !input.jobId) throw new BadRequest('jobId が必要です')
    if (input.completion) {
      const j = (await c.query('SELECT status, run_token, lease_until > now() AS lease_active FROM jobs WHERE id = $1 FOR UPDATE', [input.jobId])).rows[0]
      if (!j || j.status !== 'processing' || j.run_token !== input.completion.token || !j.lease_active) throw new Conflict('job_lease')
      const old = (await c.query("SELECT id, changes, kept FROM batches WHERE job_id = $1 AND kind = 'recording'", [input.jobId])).rows[0]
      if (old) {
        const plan: BatchPlan = { changes: old.changes, kept: old.kept, skipped: [] }
        await finishJob(c, input, old.id, plan)
        return { batchId: old.id as string, plan }
      }
    }
    const d = await lockDocument(c, input.officeId, input.documentId)
    const form = await loadFormDef(c, d.versionId)
    const allowed = new Set(form.keys)
    const fields = await readFields(c, d.id)
    const current: Record<string, CurrentField> = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v.value, by: v.by, reviewed: !!v.reviewedAt }]))
    const system = Object.fromEntries(Object.entries(input.system ?? {}).filter(([k]) => allowed.has(k)).map(([k, v]) => [k, { value: v }]))
    const proposed = { ...Object.fromEntries(Object.entries(input.proposed).filter(([k]) => allowed.has(k))), ...system }
    const plan = planBatch(current, proposed, new Set(Object.keys(system)), fieldDict(form.localFields))
    if (!plan.changes.length && !plan.kept.length) {
      if (input.completion) {
        await finishJob(c, input, null, plan)
      }
      return { batchId: null, plan }
    }
    const batch = (await c.query(
      'INSERT INTO batches (office_id, client_id, document_id, kind, label, job_id, changes, kept) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [input.officeId, d.clientId, d.id, input.kind, input.label, input.jobId ?? null, JSON.stringify(plan.changes), JSON.stringify(plan.kept)],
    )).rows[0]
    for (const ch of plan.changes) {
      await writeField(c, input.officeId, d.clientId, d.id, ch.key, ch.after, 'ai', null, { aiValue: ch.after, batchId: batch.id, cite: ch.cite })
    }
    await c.query('UPDATE clients SET updated_at = now() WHERE id = $1', [d.clientId])
    await c.query('UPDATE documents SET updated_at = now() WHERE id = $1', [d.id])
    if (input.completion) {
      await finishJob(c, input, batch.id, plan)
    }
    return { batchId: batch.id as string, plan }
  })
}

async function finishJob(c: Tx, input: ApplyInput, batchId: string | null, plan: BatchPlan) {
  const result = await c.query(
    "UPDATE jobs SET status = $3, step = 'done', batch_id = $4, steps = steps || $5::jsonb, lease_until = NULL, run_token = NULL, error_kind = NULL, updated_at = now() WHERE id = $1 AND run_token = $2 RETURNING id",
    [input.jobId, input.completion!.token, input.completion!.status, batchId, JSON.stringify({ ...input.completion!.steps, apply: { changes: plan.changes.length, kept: plan.kept.length } })],
  )
  if (!result.rows.length) throw new Conflict('job_lease')
}

/** 書類を作るときに入れる、事業所の設定の欄（様式の版が読むものだけ入れる） */
const settingsOf = (office: { name?: string, phone?: string | null, fax?: string | null } | undefined, staff: Staff): Record<string, unknown> =>
  ({ 'office.name': office?.name, 'office.careManagerName': staff.name, 'office.phone': office?.phone, 'office.fax': office?.fax })

/** 転記または事業所設定を、書き込みの履歴とともに入れる。呼び出し元が書類をロックする。 */
export async function insertCopyBatch(c: Tx, staff: Staff, document: { id: string, clientId: string }, values: Record<string, unknown>, label: string) {
  const changes = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, after]) => ({ key, op: 'add', before: null, after }))
  if (!changes.length) return 0
  const batch = (await c.query(
    "INSERT INTO batches (office_id, client_id, document_id, kind, label, changes) VALUES ($1,$2,$3,'copy',$4,$5) RETURNING id",
    [staff.officeId, document.clientId, document.id, label, JSON.stringify(changes)],
  )).rows[0]
  for (const { key, after } of changes) {
    await writeField(c, staff.officeId, document.clientId, document.id, key, after, 'ai', staff.id, { aiValue: after, batchId: batch.id })
  }
  return changes.length
}

/** 公開様式を選び、事業所設定を入れて書類を作る。元の書類を写すのは AI への依頼時（#213）。 */
export async function createDocument(db: Db, staff: Staff, clientId: string, kindKey: string): Promise<{ id: string, kind: string, created: boolean }> {
  return tx(db, (c) => createDocumentInTx(c, staff, clientId, kindKey))
}

/** 計画版の作成など、ほかの書き込みと同じトランザクションで書類を作るとき（createDocument の中身） */
export async function createDocumentInTx(c: Tx, staff: Staff, clientId: string, kindKey: string, options?: { copySourceOnCreate: boolean }): Promise<{ id: string, kind: string, created: boolean }> {
  // ほかの事業所の種類は「無い」。やめた種類は新しく作れない（#153）
  const kind = await visibleKind(c, staff.officeId, kindKey)
  if (!kind) throw new BadRequest('書類の種類がありません')
  if (kind.retired) throw new Conflict('この書類はやめたので、新しく作れません')
  // 同じ利用者の書類づくりを 1 つずつにする（何通目か・1 通だけかを決めるため）
  const client = (await c.query('SELECT id FROM clients WHERE id = $1 AND office_id = $2 AND archived_at IS NULL FOR UPDATE', [clientId, staff.officeId])).rows[0]
  if (!client) throw new NotFound()
  const existing = (await c.query('SELECT id FROM documents WHERE client_id = $1 AND kind = $2 ORDER BY seq DESC LIMIT 1', [clientId, kind.key])).rows[0]
  if (existing && kind.perClient === 'one') return { id: existing.id as string, kind: kind.key, created: false }
  const version = await publishedVersionId(c, staff.officeId, kind.key)
  const seq = Number((await c.query('SELECT coalesce(max(seq), 0) + 1 AS n FROM documents WHERE client_id = $1 AND kind = $2', [clientId, kind.key])).rows[0].n)
  const doc = (await c.query(
    'INSERT INTO documents (office_id, client_id, kind, seq, template_version_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [staff.officeId, clientId, kind.key, seq, version, staff.id],
  )).rows[0]
  const keys = new Set((await loadFormDef(c, version)).keys.filter((k) => !k.startsWith('local.')))
  const values: Record<string, unknown> = {}
  let from: string | null = null
  if (options?.copySourceOnCreate && kind.createFrom) {
    const src = (await c.query('SELECT id FROM documents WHERE client_id = $1 AND kind = $2 AND office_id = $3 ORDER BY seq DESC, created_at DESC LIMIT 1', [clientId, kind.createFrom, staff.officeId])).rows[0]
    if (src) {
      from = (await kindOf(c, kind.createFrom))?.name ?? kind.createFrom
      for (const [key, f] of Object.entries(await readFields(c, src.id))) if (keys.has(key)) values[key] = f.value
    }
  }
  const office = (await c.query('SELECT name, phone, fax FROM offices WHERE id = $1', [staff.officeId])).rows[0]
  for (const [key, value] of Object.entries(settingsOf(office, staff))) if (keys.has(key)) values[key] = value
  const copied = await insertCopyBatch(c, staff, { id: doc.id, clientId }, values,
    from ? `AI 書き込み・${from}から写した` : 'AI 書き込み・事業所の設定')
  await audit(c, staff, staff.officeId, 'document.create', { clientId, documentId: doc.id }, { form: kind.key, copied })
  return { id: doc.id as string, kind: kind.key, created: true }
}

// ---------- 録音とジョブ ----------

/** 録音を始める。録音は、録音を始めた書類（documentId）につなぐ。省いたときは主な書類 */
export async function createRecording(db: Tx, staff: Staff, clientId: string, mime: string, deviceRecordingId?: string, documentId?: string) {
  const doc = (documentId
    ? await db.query('SELECT id FROM documents WHERE id = $1 AND client_id = $2 AND office_id = $3', [documentId, clientId, staff.officeId])
    : await db.query('SELECT d.id FROM documents d JOIN form_kinds k ON k.key = d.kind AND k.is_primary WHERE d.client_id = $1 AND d.office_id = $2 ORDER BY d.seq LIMIT 1', [clientId, staff.officeId])).rows[0]
  if (!doc) throw new NotFound()
  const ext = mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac') ? 'm4a' : mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'bin'
  const inserted = (await db.query(
    `INSERT INTO recordings (office_id, client_id, document_id, object_path, mime, created_by, device_recording_id)
     VALUES ($1,$2,$3,'',$4,$5,$6)
     ON CONFLICT (office_id, client_id, device_recording_id) DO NOTHING RETURNING id`,
    [staff.officeId, clientId, doc.id, mime, staff.id, deviceRecordingId ?? null],
  )).rows[0]
  if (inserted) {
    const objectPath = `recordings/${staff.officeId}/${clientId}/${inserted.id}.${ext}`
    await db.query('UPDATE recordings SET object_path = $1 WHERE id = $2', [objectPath, inserted.id])
    await audit(db, staff, staff.officeId, 'recording.start', { clientId, documentId: doc.id })
    return { id: inserted.id as string, objectPath, mime, status: 'uploading', uploadUrl: null }
  }
  const r = (await db.query(
    `SELECT id, object_path, mime, status, upload_url FROM recordings
     WHERE office_id = $1 AND client_id = $2 AND device_recording_id = $3 FOR UPDATE`,
    [staff.officeId, clientId, deviceRecordingId],
  )).rows[0]
  if (r.mime !== mime) throw new Conflict('同じ録音IDの形式が一致しません')
  return { id: r.id as string, objectPath: r.object_path as string, mime: r.mime as string, status: r.status as string, uploadUrl: r.upload_url as string | null }
}

export async function setRecordingUploadUrl(db: Tx, recordingId: string, url: string) {
  const result = await db.query(
    `UPDATE recordings
        SET upload_url = $1, upload_started_at = now(), upload_completed_at = NULL, status = 'uploading',
            upload_cancel_attempts = 0, upload_cancel_claim_token = NULL, upload_cancel_claimed_at = NULL,
            upload_cancel_last_attempt_at = NULL, upload_cancel_next_retry_at = NULL,
            upload_cancel_last_error_code = NULL, upload_cancel_escalated_at = NULL
      WHERE id = $2 AND status IN ('uploading', 'failed')
      RETURNING id`,
    [url, recordingId],
  )
  if (!result.rows.length) throw new Conflict('録音のアップロード状態を変更できません')
}

export interface UploadedRecordingObject {
  size: number
  generation: string
  metageneration: string
}

/** 録音の行をロックし、完了とジョブの作成を同じトランザクションで確定する。 */
export async function completeRecording(
  db: Db, staff: Staff, recordingId: string, durationMs: number | null, expectedBytes: number | undefined,
  uploadedObject: (path: string) => Promise<number | UploadedRecordingObject | null>,
): Promise<string | null> {
  return tx(db, async (c) => {
    const rec = (await c.query(
      'SELECT client_id, document_id, object_path, bytes, status, source_delete_status, source_generation, source_metageneration FROM recordings WHERE id = $1 AND office_id = $2 FOR UPDATE',
      [recordingId, staff.officeId],
    )).rows[0]
    if (!rec) throw new NotFound()
    if (rec.status === 'abandoning') throw new Conflict('録音アップロードを整理中です')
    const existing = (await c.query('SELECT id FROM jobs WHERE recording_id = $1', [recordingId])).rows[0]
    const uploaded: number | UploadedRecordingObject | null = existing ? null : await uploadedObject(rec.object_path)
    const bytes = existing ? Number(rec.bytes) : typeof uploaded === 'number' ? uploaded : uploaded?.size ?? null
    if (!bytes || (expectedBytes !== undefined && bytes !== expectedBytes)) return null
    if (existing) return existing.id as string

    const uploadedMetadata = uploaded && typeof uploaded === 'object' ? uploaded : null
    await c.query(
      `UPDATE recordings
          SET status = 'uploaded', bytes = $1, duration_ms = $2, upload_url = NULL,
              upload_completed_at = now(), source_generation = $4, source_metageneration = $5,
              upload_cancel_claim_token = NULL, upload_cancel_claimed_at = NULL,
              upload_cancel_next_retry_at = NULL, upload_cancel_last_error_code = NULL
        WHERE id = $3`,
      [bytes, durationMs, recordingId, uploadedMetadata?.generation ?? null, uploadedMetadata?.metageneration ?? null],
    )
    await setRecordingRetentionOnComplete(c, recordingId, {
      officeId: staff.officeId, actorStaffId: staff.id, clientId: rec.client_id, documentId: rec.document_id,
      auditContext: auditContextOf(staff),
    })
    const eta = durationMs ? Math.max(60, Math.round(durationMs / 1000 / 6) + 90) : 300
    const job = (await c.query(
      'INSERT INTO jobs (office_id, client_id, document_id, recording_id, eta_seconds) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [staff.officeId, rec.client_id, rec.document_id, recordingId, eta],
    )).rows[0]
    await audit(c, staff, staff.officeId, 'recording.complete', { clientId: rec.client_id, documentId: rec.document_id }, { bytes, durationMs })
    return job.id as string
  })
}

/** worker にジョブが見えるよう、ジョブ作成の確定後に積む。積めなければ次の complete でやり直せる。 */
export async function dispatchRecordingJob(db: Db, jobId: string, enqueue: () => Promise<void>) {
  return tx(db, async (c) => {
    const job = (await c.query('SELECT status, initial_enqueued_at FROM jobs WHERE id = $1 FOR UPDATE', [jobId])).rows[0]
    if (job.status === 'queued' && !job.initial_enqueued_at) {
      await enqueue()
      await c.query('UPDATE jobs SET initial_enqueued_at = now() WHERE id = $1', [jobId])
    }
    return { jobId, status: job.status as string }
  })
}

export interface JobView {
  id: string
  documentId: string
  status: string
  step: string | null
  etaSeconds: number | null
  createdAt: string
  updatedAt: string
  batch: { changes: number, kept: number } | null
  incompleteFields: string[]
  errorKind: string | null
}

/** 処理中・直近 15 分のジョブと、最後のジョブ（後日も失敗が分かるようにする） */
export async function activeJobs(db: Q, officeId: string, clientId: string): Promise<JobView[]> {
  const r = await db.query(
    `SELECT j.id, j.document_id, j.status, j.step, j.eta_seconds, j.created_at, j.updated_at, j.error_kind,
            j.steps #> '{write,incompleteFields}' AS incomplete_fields,
            jsonb_array_length(b.changes) AS n, jsonb_array_length(b.kept) AS k
     FROM jobs j LEFT JOIN batches b ON b.id = j.batch_id
     WHERE j.office_id = $1 AND j.client_id = $2
       AND (j.status IN ('queued', 'processing') OR j.updated_at > now() - interval '15 minutes'
            OR j.id = (SELECT last.id FROM jobs last WHERE last.office_id = $1 AND last.client_id = $2 ORDER BY last.created_at DESC LIMIT 1))
     ORDER BY j.created_at DESC LIMIT 5`,
    [officeId, clientId],
  )
  return r.rows.map((j) => ({
    id: j.id,
    documentId: j.document_id,
    status: j.status,
    step: j.step,
    etaSeconds: j.eta_seconds,
    createdAt: new Date(j.created_at).toISOString(),
    updatedAt: new Date(j.updated_at).toISOString(),
    batch: j.n === null ? null : { changes: Number(j.n), kept: Number(j.k) },
    incompleteFields: stringValues(j.incomplete_fields),
    errorKind: j.error_kind ?? null,
  }))
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const strings: string[] = value.filter((item): item is string => typeof item === 'string')
  return [...new Set(strings)]
}
