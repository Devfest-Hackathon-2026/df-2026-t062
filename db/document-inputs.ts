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
  document_id: string
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
  template_version_id: string | null
  upload_generation: number
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
/** 置き場の原本が、送信時の大きさ・ハッシュ・種類と一致するか。未検証の送信を採用済みの原本と混同しない。 */
async function verifiedOriginal(storage: Storage, path: string, r: { bytes: number, sha256: string, mime: DocumentInputView['mime'] }): Promise<boolean> {
  try {
    const data = await storage.read('source', path)
    if (data.length !== r.bytes || createHash('sha256').update(data).digest('hex') !== r.sha256) return false
    checkDocumentSignature(data, r.mime)
    return true
  } catch {
    return false
  }
}

export async function startInput(db: Db, staff: Staff, documentId: string, input: z.infer<typeof DocumentUploadInput>, storage: Storage, origin?: string) {
  return tx(db, async (c) => {
    const doc = await getDocument(c, staff.officeId, documentId)
    await c.query(`INSERT INTO document_inputs (office_id,client_id,document_id,created_by,file_name,mime,sha256,bytes,template_version_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (document_id,sha256) DO NOTHING`,
    [staff.officeId, doc.clientId, doc.id, staff.id, input.fileName, input.mime, input.sha256, input.bytes, doc.formVersionId])
    const r = (await c.query<StoredInput>('SELECT * FROM document_inputs WHERE document_id=$1 AND sha256=$2 FOR UPDATE', [documentId, input.sha256])).rows[0]
    if (r.mime !== input.mime || r.bytes !== input.bytes) throw new Conflict('原本の情報が一致しません')
    // 読取後に様式の版が変わっていたら、古い候補のままにせず、同じ原本を今の版で読み取り直す。
    if (r.status === 'review' && r.template_version_id !== doc.formVersionId) {
      await c.query(`UPDATE document_inputs SET status='queued',result=NULL,summary_bundle=NULL,error_kind=NULL,attempts=0,run_token=NULL,lease_until=NULL,
        upload_url=NULL,template_version_id=$2,updated_at=now() WHERE id=$1`, [r.id, doc.formVersionId])
      r.status = 'queued'; r.result = null; r.error_kind = null; r.upload_url = null; r.template_version_id = doc.formVersionId
    }
    if (r.status === 'uploading') {
      const path = documentInputPath(staff.officeId, r.client_id, r.id, r.upload_generation)
      const present = await storage.size('source', path)
      if (present !== null && await verifiedOriginal(storage, path, r)) {
        // 送信済みで中身も確かなものは、送り直さずに完了の確認へ進む。
        if (r.upload_url) await c.query('UPDATE document_inputs SET upload_url=NULL,updated_at=now() WHERE id=$1', [r.id])
        r.upload_url = null
      } else if (present !== null || !r.upload_url || r.upload_url === input.expiredUploadUrl) {
        // 壊れた未検証の原本は残し、次の送信は別の世代へ。正常な送信は同じ場所・同じ URL のまま冪等。
        let generation = r.upload_generation
        if (present !== null || r.upload_url === input.expiredUploadUrl && !!r.upload_url) {
          generation += 1
        }
        const next = documentInputPath(staff.officeId, r.client_id, r.id, generation)
        const uploadUrl = await storage.createUploadSession('source', next, input.mime, origin)
        await c.query('UPDATE document_inputs SET upload_url=$2,upload_generation=$3,updated_at=now() WHERE id=$1', [r.id, uploadUrl, generation])
        r.upload_url = uploadUrl
        r.upload_generation = generation
      }
    }
    return { input: view(r), uploadUrl: r.status === 'uploading' ? r.upload_url : null }
  })
}
export async function completeInput(db: Db, staff: Staff, id: string, storage: Storage) {
  const failed = await tx(db, async (c) => {
    const r = (await c.query<StoredInput>('SELECT * FROM document_inputs WHERE id=$1 AND office_id=$2 FOR UPDATE', [id, staff.officeId])).rows[0]
    if (!r) throw new NotFound()
    if (r.status !== 'uploading') return null
    const path = documentInputPath(staff.officeId, r.client_id, r.id, r.upload_generation)
    const size = await storage.size('source', path)
    if (size === null) throw new Conflict('ファイルの送信が完了していません')
    const data = size === r.bytes ? await storage.read('source', path) : null
    let error: Error | null = null
    if (!data || data.length !== r.bytes) error = new Conflict('ファイルの送信が完了していません')
    else if (createHash('sha256').update(data).digest('hex') !== r.sha256) error = new BadRequest('ファイルのハッシュが一致しません')
    else {
      try { checkDocumentSignature(data, r.mime) } catch (e) {
        if (!(e instanceof DocumentReadError)) throw e
        error = new BadRequest('ファイルの種類と内容が一致しません')
      }
    }
    if (!error) {
      await c.query("UPDATE document_inputs SET status='queued',upload_url=NULL,updated_at=now() WHERE id=$1", [id])
      return null
    }
    // 検証に落ちた原本は使わない。次の送信は別の世代にして、古い送信の続きに引きずられないようにする。
    await c.query('UPDATE document_inputs SET upload_url=NULL,upload_generation=upload_generation+1,updated_at=now() WHERE id=$1', [id])
    return { error, stalePath: path }
  })
  if (failed) {
    await storage.remove('source', failed.stalePath).catch(() => {})
    throw failed.error
  }
}
export async function inputView(db: Db, staff: Staff, id: string) { return view(await getInput(db, staff.officeId, id)) }

export async function adoptInput(db: Db, staff: Staff, id: string, changes: { key: string, value?: unknown, base: unknown }[]) {
  return tx(db, async (c) => {
    const r = (await c.query<StoredInput>('SELECT * FROM document_inputs WHERE id=$1 AND office_id=$2 FOR UPDATE', [id, staff.officeId])).rows[0]
    if (!r) throw new NotFound()
    if (r.status !== 'review') throw new Conflict('読み取りは完了していません')
    const result = r.result as DocumentInputResult
    for (const ch of changes) {
      const candidate = result.candidates.find((v) => v.key === ch.key)
      if (!candidate || 'value' in ch && !sameValue(candidate.value, ch.value)) throw new BadRequest('候補と違う値は反映できません')
    }
    const adopted = new Set<string>(r.adopted)
    const pending = changes.filter((ch) => !adopted.has(ch.key))
    // 既に採用済みの再送は、版が変わっていても値を書き換えないので、そのまま返す（冪等）。
    if (!pending.length) return getDocument(c, staff.officeId, r.document_id)
    // 候補を作ったときの版と、今の書類の版を同じトランザクションで確かめる。違えば古い候補は使わない。
    const doc = (await c.query('SELECT template_version_id FROM documents WHERE id=$1 AND office_id=$2 FOR UPDATE', [r.document_id, staff.officeId])).rows[0]
    if (!doc) throw new NotFound()
    if (!r.template_version_id || r.template_version_id !== doc.template_version_id) throw new Conflict('form_version')
    const form = await loadFormDef(c, doc.template_version_id)
    const dict = fieldDict(form.localFields)
    const fields = pending.map((ch) => {
      const candidate = result.candidates.find((v) => v.key === ch.key)
      // 値はサーバーが保存した候補だけを使う。クライアントが値を送った場合は、候補との完全一致だけを認める。
      if (!candidate || candidate.value == null || !validValue(ch.key, candidate.value, {}, dict)) throw new BadRequest('候補と値を確認してください')
      if ('value' in ch && !sameValue(candidate.value, ch.value)) throw new BadRequest('候補と違う値は反映できません')
      if (!sameValue(candidate.base, ch.base)) throw new Conflict(ch.key)
      const evidence = result.evidence.filter((e) => candidate.cite.includes(e.id))
      if (!evidence.length || candidate.cite.some((id) => !evidence.some((e) => e.id === id)) || evidence.some((e) => e.uncertain)) throw new BadRequest('原本の根拠がありません')
      const documentSource: DocumentSource = { kind: 'document-input', inputId: id, fileName: r.file_name, sha256: r.sha256, evidence }
      return { key: ch.key, value: candidate.value, base: ch.base, documentSource }
    })
    if (fields.length) await patchFields(db, staff, r.document_id, fields, (fn) => fn(c))
    const adoptedValues = { ...r.adopted_values }
    for (const field of fields) {
      adopted.add(field.key)
      adoptedValues[field.key] = field.value
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
