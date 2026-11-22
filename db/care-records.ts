import { careRecordConfig, type CareRecordKind, type CareRecordSummary, type CareRecordRevision } from '../core/care-record.ts'
import type { Db, Tx } from './pool.ts'
import { tx } from './pool.ts'
import { createDocumentInTx, Conflict, NotFound, type Staff } from './repo.ts'
const PAGE_SIZE = 50
async function client(db: Db | Tx, officeId: string, clientId: string, lock = false) {
  if (!(await db.query(`SELECT id FROM clients WHERE id=$1 AND office_id=$2 AND archived_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [clientId, officeId])).rows.length) throw new NotFound()
}
export async function createCareRecord(db: Db, staff: Staff, clientId: string, input: { kind: CareRecordKind, requestId: string }) {
  return tx(db, async c => {
    await client(c, staff.officeId, clientId, true)
    const old = (await c.query('SELECT c.document_id,d.kind FROM care_record_creations c JOIN documents d ON d.id=c.document_id WHERE c.office_id=$1 AND c.client_id=$2 AND c.request_id=$3', [staff.officeId, clientId, input.requestId])).rows[0]
    if (old) { if (old.kind !== input.kind) throw new Conflict('record_kind'); return { id: old.document_id as string, created: false } }
    const doc = await createDocumentInTx(c, staff, clientId, input.kind)
    await c.query('INSERT INTO care_record_creations (office_id,client_id,request_id,document_id) VALUES ($1,$2,$3,$4)', [staff.officeId, clientId, input.requestId, doc.id])
    return { id: doc.id, created: true }
  })
}
export async function listCareRecords(db: Db, officeId: string, clientId: string, filter: { kind?: CareRecordKind, q: string, from?: string, to?: string, offset: number }) {
  await client(db, officeId, clientId)
  const kind = filter.kind ?? 'care_plan_5'
  const config = careRecordConfig[kind]
  // Search the whole current text, return only a preview. An escaped pattern treats %/_ as literal user text.
  const pattern = '%' + filter.q.replace(/[\\%_]/g, '\\$&') + '%'
  const r = await db.query(`WITH records AS (
    SELECT d.id,d.seq,d.updated_at,
      (SELECT f.value #>> '{}' FROM field_values f WHERE f.document_id=d.id AND f.key=$10) AS date,
      (SELECT f.value #>> '{}' FROM field_values f WHERE f.document_id=d.id AND f.key=$11) AS time,
      (SELECT f.value #>> '{}' FROM field_values f WHERE f.document_id=d.id AND f.key=$12) AS category,
      (SELECT f.value #>> '{}' FROM field_values f WHERE f.document_id=d.id AND f.key=$13) AS content,
      (SELECT coalesce(max(v.rev),0)::int FROM revisions v WHERE v.document_id=d.id) AS revision
    FROM documents d WHERE d.office_id=$1 AND d.client_id=$2 AND d.kind=$9
  ) SELECT id,seq,updated_at,date,time,category,left(coalesce(content,''),160) AS preview,revision
    FROM records WHERE ($3='' OR coalesce(category,'') ILIKE $4 OR coalesce(content,'') ILIKE $4)
    AND ($5::text IS NULL OR date >= $5) AND ($6::text IS NULL OR date <= $6)
    ORDER BY date DESC NULLS LAST,time DESC NULLS LAST,seq DESC,id DESC LIMIT $7 OFFSET $8`,
  [officeId, clientId, filter.q, pattern, filter.from ?? null, filter.to ?? null, PAGE_SIZE + 1, filter.offset, kind, config.date, config.time, config.category, config.content])
  const records: CareRecordSummary[] = r.rows.slice(0, PAGE_SIZE).map(r => ({ id: r.id, seq: Number(r.seq), date: r.date, time: r.time, category: r.category, preview: r.preview, revision: Number(r.revision), updatedAt: new Date(r.updated_at).toISOString() }))
  return { records, hasMore: r.rows.length > PAGE_SIZE }
}
export async function careRecordRevision(db: Db, officeId: string, id: string, rev: number): Promise<CareRecordRevision> {
  const r = (await db.query(`SELECT v.rev,v.saved_at,v.template_version_id,v."values" FROM revisions v JOIN documents d ON d.id=v.document_id
    WHERE d.id=$1 AND d.office_id=$2 AND d.kind IN ('care_plan_4','care_plan_5') AND v.rev=$3`, [id, officeId, rev])).rows[0]
  if (!r) throw new NotFound()
  return { rev: Number(r.rev), savedAt: new Date(r.saved_at).toISOString(), formVersionId: r.template_version_id, values: r.values }
}
