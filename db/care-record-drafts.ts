import { z } from 'zod'
import { sameValue } from '../core/apply-batch.ts'
import { chatError } from '../core/chat-error.ts'
import type { CareRecordDrafter, CareRecordDraftView, CareRecordSources } from '../core/care-record.ts'
import type { Db } from './pool.ts'
import { tx } from './pool.ts'
import { audit, Conflict, getDocument, NotFound, patchFields, type Staff } from './repo.ts'
import { loadFormDef } from './forms.ts'
const resultSchema = z.object({ guidance: z.string().max(10000), proposals: z.array(z.object({ key: z.enum(['progress.content','progress.category']), label: z.string(), before: z.unknown(), after: z.string().max(100000) })).max(2) })
const view = (r: Record<string, any>): CareRecordDraftView => ({
  id: r.id, status: r.status === 'generating' && Date.now() - new Date(r.created_at).getTime() > 180000 ? 'failed' : r.status, guidance: r.result?.guidance ?? '', proposals: r.result?.proposals ?? [], errorCode: r.status === 'generating' && Date.now() - new Date(r.created_at).getTime() > 180000 ? 'interrupted' : r.error_code,
  capturedAt: r.source.capturedAt, documentSources: r.source.documents.map(({ id, documentId, rev, savedAt }: CareRecordSources['documents'][number]) => ({ id, documentId, rev, savedAt })),
  recordingSources: r.source.recordings.map(({ id, recordedAt }: CareRecordSources['recordings'][number]) => ({ id, recordedAt })), appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : null,
})
async function record(db: Db, officeId: string, id: string) {
  const doc = await getDocument(db, officeId, id)
  if (doc.kind !== 'care_plan_5') throw new NotFound()
  return doc
}
export async function careRecordDrafts(db: Db, officeId: string, id: string) {
  await record(db, officeId, id)
  return (await db.query('SELECT * FROM care_record_drafts WHERE document_id=$1 AND office_id=$2 ORDER BY created_at DESC LIMIT 10', [id, officeId])).rows.map(view)
}
export async function createCareRecordDraft(db: Db, staff: Staff, id: string, input: { requestId: string, instructions: string }, drafter: CareRecordDrafter) {
  const doc = await record(db, staff.officeId, id)
  const form = await loadFormDef(db, doc.formVersionId)
  const prepared = await tx(db, async c => {
    // Serializes retries on this document without holding the transaction during an AI call.
    await c.query('SELECT id FROM documents WHERE id=$1 AND office_id=$2 FOR UPDATE', [id, staff.officeId])
    const previous = (await c.query('SELECT * FROM care_record_drafts WHERE document_id=$1 AND request_id=$2 AND office_id=$3', [id, input.requestId, staff.officeId])).rows[0]
    if (previous) return { row: previous, generate: false }
    const saved = (await c.query(`SELECT v.id::text,d.id AS document_id,d.kind,v.rev,v.saved_at,v.template_version_id,v."values" FROM documents d JOIN LATERAL
      (SELECT * FROM revisions r WHERE r.document_id=d.id AND r.office_id=d.office_id ORDER BY r.rev DESC LIMIT 1) v ON true WHERE d.client_id=$1 AND d.office_id=$2`, [doc.clientId, staff.officeId])).rows
    const recordings = (await c.query(`SELECT r.id,r.recorded_at,t.utterances FROM recordings r JOIN transcripts t ON t.recording_id=r.id AND t.office_id=r.office_id AND t.client_id=r.client_id WHERE r.office_id=$1 AND r.client_id=$2 ORDER BY r.recorded_at`, [staff.officeId, doc.clientId])).rows
    const source: CareRecordSources = {
      capturedAt: new Date().toISOString(), instructions: input.instructions,
      documents: saved.map(r => ({ id: r.id, documentId: r.document_id, kind: r.kind, rev: Number(r.rev), savedAt: new Date(r.saved_at).toISOString(), formVersionId: r.template_version_id, values: r.values })),
      recordings: recordings.map(r => ({ id: r.id, recordedAt: new Date(r.recorded_at).toISOString(), utterances: r.utterances })),
    }
    const base = Object.fromEntries(Object.entries(doc.fields).map(([key, row]) => [key, row.value]))
    const row = (await c.query(`INSERT INTO care_record_drafts (office_id,client_id,document_id,template_version_id,request_id,source,base,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'generating',$8) RETURNING *`, [staff.officeId, doc.clientId, id, doc.formVersionId, input.requestId, JSON.stringify(source), JSON.stringify(base), staff.id])).rows[0]
    return { row, generate: true }
  })
  if (!prepared.generate) return view(prepared.row)
  let result: z.infer<typeof resultSchema> = { guidance: '', proposals: [] }, status = 'ready', error: string | null = null
  try {
    result = resultSchema.parse(await drafter({ source: prepared.row.source, current: prepared.row.base, form }))
    if (new Set(result.proposals.map(p => p.key)).size !== result.proposals.length || result.proposals.some(p => !sameValue(p.before, prepared.row.base[p.key] ?? null))) throw new Error('Invalid proposal base')
  } catch (e) { status = 'failed'; result = { guidance: '', proposals: [] }; error = (e as { code?: string })?.code === 'not_configured' ? 'not_configured' : chatError(e).code }
  const row = (await db.query('UPDATE care_record_drafts SET status=$1,result=$2,error_code=$3 WHERE id=$4 AND office_id=$5 RETURNING *', [status, JSON.stringify(result), error, prepared.row.id, staff.officeId])).rows[0]
  return view(row)
}
export async function applyCareRecordDraft(db: Db, staff: Staff, id: string, draftId: string) {
  return tx(db, async c => {
    // Use the same lock order as create: document, then draft.
    const d = (await c.query("SELECT * FROM documents WHERE id=$1 AND office_id=$2 AND kind='care_plan_5' FOR UPDATE", [id, staff.officeId])).rows[0]
    if (!d) throw new NotFound()
    const row = (await c.query('SELECT * FROM care_record_drafts WHERE id=$1 AND document_id=$2 AND office_id=$3 FOR UPDATE', [draftId, id, staff.officeId])).rows[0]
    if (!row) throw new NotFound()
    if (row.applied_at) return view(row)
    if (row.status !== 'ready' || row.template_version_id !== d.template_version_id) throw new Conflict('record_draft')
    const result = resultSchema.parse(row.result)
    if (!result.proposals.length) throw new Conflict('record_draft')
    // Existing field-level conflict and schema validation; entire adoption rolls back on any changed base.
    await patchFields(db, staff, id, result.proposals.map(p => ({ key: p.key, value: p.after, base: p.before })), fn => fn(c))
    const adopted = (await c.query('UPDATE care_record_drafts SET applied_at=now(),applied_by=$1 WHERE id=$2 RETURNING *', [staff.id, draftId])).rows[0]
    await audit(c, staff, staff.officeId, 'care_record.draft_apply', { clientId: d.client_id, documentId: id }, { draftId, fields: result.proposals.length })
    return view(adopted)
  })
}
