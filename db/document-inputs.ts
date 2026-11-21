import { createHash } from 'node:crypto'
import { z } from 'zod'
import { checkDocumentSignature, DocumentReadError, documentInputPath, DOCUMENT_MIMES, MAX_DOCUMENT_BYTES, type DocumentInputResult, type DocumentInputView, type DocumentSource } from '../core/document-input.ts'
import { sameValue } from '../core/apply-batch.ts'
import { fieldDict } from '../core/dictionary.ts'
import { loadFormDef } from './forms.ts'
import { validValue } from '../core/schema.ts'
import type { Storage } from '../api/storage.ts'
import { tx, type Db, type Tx } from './pool.ts'
import { BadRequest, Conflict, NotFound, getDocument, patchFields, type Staff } from './repo.ts'

export const DocumentUploadInput = z.object({
  fileName: z.string().trim().min(1).max(255), mime: z.enum(DOCUMENT_MIMES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
  expiredUploadUrl: z.string().max(4096).optional(),
})
type Q = Db | Tx
interface StoredInput {
  id: string
  client_id: string
  file_name: string
  mime: DocumentInputView['mime']
  sha256: string
  bytes: number
  status: DocumentInputView['status']
  upload_url: string | null
  error_kind: string | null
  created_at: Date
  result: DocumentInputResult | null
  adopted: string[]
  adopted_values: Record<string, unknown>
}
function view(row: StoredInput): DocumentInputView {
  return {
    id: row.id, fileName: row.file_name, mime: row.mime, sha256: row.sha256,
    status: row.status, errorKind: row.error_kind, createdAt: new Date(row.created_at).toISOString(),
    result: row.result, adopted: row.adopted, adoptedValues: row.adopted_values,
  }
}

export async function getInput(db: Q, officeId: string, id: string) {
  const r = (await db.query<StoredInput>('SELECT * FROM document_inputs WHERE id=$1 AND office_id=$2', [id, officeId])).rows[0]
  if (!r) throw new NotFound()
  return r
}
export async function listInputs(db: Db, staff: Staff, documentId: string) {
  await getDocument(db, staff.officeId, documentId)
  return (await db.query<StoredInput>('SELECT * FROM document_inputs WHERE document_id=$1 AND office_id=$2 ORDER BY created_at DESC', [documentId, staff.officeId])).rows.map(view)
}
export async function startInput(db: Db, staff: Staff, documentId: string, input: z.infer<typeof DocumentUploadInput>, storage: Storage, origin?: string) {
  return tx(db, async (c) => {
    const doc = await getDocument(c, staff.officeId, documentId)
    await c.query(`INSERT INTO document_inputs (office_id,client_id,document_id,created_by,file_name,mime,sha256,bytes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (document_id,sha256) DO NOTHING`,
    [staff.officeId, doc.clientId, doc.id, staff.id, input.fileName, input.mime, input.sha256, input.bytes])
    const r = (await c.query('SELECT * FROM document_inputs WHERE document_id=$1 AND sha256=$2 FOR UPDATE', [documentId, input.sha256])).rows[0]
    if (r.mime !== input.mime || r.bytes !== input.bytes) throw new Conflict('原本の情報が一致しません')
    if (r.status === 'uploading' && (!r.upload_url || r.upload_url === input.expiredUploadUrl)) {
      const path = documentInputPath(staff.officeId, doc.clientId, r.id)
      if (await storage.size('source', path) === null) {
        r.upload_url = await storage.createUploadSession('source', path, input.mime, origin)
        await c.query('UPDATE document_inputs SET upload_url=$2 WHERE id=$1', [r.id, r.upload_url])
      } else r.upload_url = null
    }
    return { input: view(r), uploadUrl: r.status === 'uploading' ? r.upload_url : null }
  })
}
export async function completeInput(db: Db, staff: Staff, id: string, storage: Storage) {
  return tx(db, async (c) => {
    const r = await getInput(c, staff.officeId, id)
    const locked = (await c.query('SELECT status FROM document_inputs WHERE id=$1 FOR UPDATE', [id])).rows[0]
    if (locked.status !== 'uploading') return
    const path = documentInputPath(staff.officeId, r.client_id, id)
    if (await storage.size('source', path) !== r.bytes) throw new Conflict('ファイルの送信が完了していません')
    const data = await storage.read('source', path)
    if (createHash('sha256').update(data).digest('hex') !== r.sha256) throw new BadRequest('ファイルのハッシュが一致しません')
    try { checkDocumentSignature(data, r.mime) } catch (e) {
      if (e instanceof DocumentReadError) throw new BadRequest('ファイルの種類と内容が一致しません')
      throw e
    }
    await c.query("UPDATE document_inputs SET status='queued',upload_url=NULL,updated_at=now() WHERE id=$1", [id])
  })
}
export async function inputView(db: Db, staff: Staff, id: string) { return view(await getInput(db, staff.officeId, id)) }

export async function adoptInput(db: Db, staff: Staff, id: string, changes: { key: string, value: unknown, base: unknown }[]) {
  return tx(db, async (c) => {
    const r = (await c.query('SELECT * FROM document_inputs WHERE id=$1 AND office_id=$2 FOR UPDATE', [id, staff.officeId])).rows[0]
    if (!r) throw new NotFound()
    if (r.status !== 'review') throw new Conflict('読み取りは完了していません')
    const doc = await getDocument(c, staff.officeId, r.document_id)
    const form = await loadFormDef(c, doc.formVersionId)
    const dict = fieldDict(form.localFields)
    const result = r.result as DocumentInputResult
    const adopted = new Set<string>(r.adopted)
    const pending = changes.filter((ch) => !adopted.has(ch.key))
    const fields = pending.map((ch) => {
      const candidate = result.candidates.find((v) => v.key === ch.key)
      if (!candidate || !validValue(ch.key, ch.value, {}, dict) || ch.value == null) throw new BadRequest('候補と値を確認してください')
      if (!sameValue(candidate.base, ch.base)) throw new Conflict(ch.key)
      const evidence = result.evidence.filter((e) => candidate.cite.includes(e.id))
      if (!evidence.length) throw new BadRequest('原本の根拠がありません')
      const documentSource: DocumentSource = { kind: 'document-input', inputId: id, fileName: r.file_name, sha256: r.sha256, evidence }
      return { ...ch, documentSource }
    })
    if (fields.length) await patchFields(db, staff, r.document_id, fields, (fn) => fn(c))
    const adoptedValues = { ...r.adopted_values }
    for (const ch of pending) {
      adopted.add(ch.key)
      adoptedValues[ch.key] = ch.value
    }
    await c.query('UPDATE document_inputs SET adopted=$2,adopted_values=$3,updated_at=now() WHERE id=$1', [id, JSON.stringify([...adopted]), JSON.stringify(adoptedValues)])
    return getDocument(c, staff.officeId, r.document_id)
  })
}

export async function retryInput(db: Db, staff: Staff, id: string) {
  await getInput(db, staff.officeId, id)
  const r = await db.query(`UPDATE document_inputs SET status='queued',attempts=0,error_kind=NULL,run_token=NULL,lease_until=NULL,updated_at=now()
    WHERE id=$1 AND office_id=$2 AND status='failed' AND error_kind IN ('location_not_approved','reader_not_configured','writer_not_configured','no_topics','processing_failed','attempts_exhausted') RETURNING id`, [id, staff.officeId])
  if (!r.rows.length) throw new Conflict('再実行できる状態ではありません')
}
