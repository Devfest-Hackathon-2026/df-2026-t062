import { writeBusinessAudit, type AuditContext } from './audit.ts'
import { tx, type Db, type Tx } from './pool.ts'

export const RECORDING_RETENTION_POLICY_VERSION = 'recording-retention-v1'
export const RECORDING_MAX_RETENTION_DAYS = 7
export const RECORDING_SUCCESS_RETENTION_HOURS = 72

export type SourceDeleteStatus = 'pending' | 'eligible' | 'requested' | 'deleting' | 'deleted' | 'failed'

export interface RecordingRetentionContext {
  officeId: string
  actorStaffId?: string | null
  clientId?: string | null
  documentId?: string | null
  auditContext?: AuditContext
}

export interface RecordingRetentionState {
  recordingId: string
  sourceExpiresAt: string
  sourceDeletedAt: string | null
  sourceDeleteStatus: SourceDeleteStatus
  retentionPolicyVersion: string
  retentionHold: boolean
  retentionHoldUntil: string | null
  retentionHoldReasonCode: string | null
  retentionHoldSetAt: string | null
  retentionHoldSetBy: string | null
}

function state(row: Record<string, unknown>): RecordingRetentionState {
  return {
    recordingId: row.id as string,
    sourceExpiresAt: new Date(row.source_expires_at as string).toISOString(),
    sourceDeletedAt: row.source_deleted_at ? new Date(row.source_deleted_at as string).toISOString() : null,
    sourceDeleteStatus: row.source_delete_status as SourceDeleteStatus,
    retentionPolicyVersion: row.retention_policy_version as string,
    retentionHold: row.retention_hold as boolean,
    retentionHoldUntil: row.retention_hold_until ? new Date(row.retention_hold_until as string).toISOString() : null,
    retentionHoldReasonCode: row.retention_hold_reason_code as string | null,
    retentionHoldSetAt: row.retention_hold_set_at ? new Date(row.retention_hold_set_at as string).toISOString() : null,
    retentionHoldSetBy: row.retention_hold_set_by as string | null,
  }
}

async function retentionAudit(db: Db | Tx, input: RecordingRetentionContext & {
  action: string
  recordingId: string
  detail: Record<string, unknown>
}) {
  await writeBusinessAudit(db, {
    officeId: input.officeId,
    actorStaffId: input.actorStaffId,
    action: input.action,
    ids: { clientId: input.clientId ?? undefined, documentId: input.documentId ?? undefined },
    detail: { recordingId: input.recordingId, policyVersion: RECORDING_RETENTION_POLICY_VERSION, ...input.detail },
    context: input.auditContext,
  })
}

export async function setRecordingRetentionOnComplete(db: Db | Tx, recordingId: string, context: RecordingRetentionContext) {
  const before = (await db.query(
    'SELECT source_delete_status FROM recordings WHERE id = $1 AND office_id = $2 FOR UPDATE',
    [recordingId, context.officeId],
  )).rows[0]
  if (!before) throw new Error('recording_not_found')
  const updated = (await db.query(
    `UPDATE recordings
        SET source_expires_at = recorded_at + interval '7 days',
            source_delete_status = CASE
              WHEN retention_hold THEN 'pending'
              WHEN recorded_at + interval '7 days' <= now() THEN 'eligible'
              ELSE 'pending'
            END
      WHERE id = $1 AND office_id = $2 AND source_delete_status <> 'deleted'
      RETURNING id, source_delete_status`,
    [recordingId, context.officeId],
  )).rows[0]
  if (!updated) return null
  await retentionAudit(db, { ...context, action: 'recording.retention_set', recordingId, detail: {
    previousStatus: before.source_delete_status,
    nextStatus: updated.source_delete_status,
    trigger: 'recording_complete',
  } })
  return updated.source_delete_status as SourceDeleteStatus
}

export async function setRecordingSuccessRetention(db: Db | Tx, jobId: string, context: RecordingRetentionContext) {
  const before = (await db.query(
    `SELECT r.id, r.client_id, r.document_id, r.source_delete_status
       FROM recordings r JOIN jobs j ON j.recording_id = r.id
      WHERE j.id = $1 AND r.office_id = $2
      FOR UPDATE OF r`,
    [jobId, context.officeId],
  )).rows[0]
  if (!before) throw new Error('recording_not_found')
  const updated = (await db.query(
    `UPDATE recordings
        SET source_expires_at = LEAST(source_expires_at, recorded_at + interval '7 days', now() + interval '72 hours'),
            source_delete_status = CASE
              WHEN retention_hold THEN 'pending'
              WHEN LEAST(source_expires_at, recorded_at + interval '7 days', now() + interval '72 hours') <= now() THEN 'eligible'
              ELSE 'pending'
            END
      WHERE id = $1 AND source_delete_status <> 'deleted'
      RETURNING id, source_delete_status`,
    [before.id],
  )).rows[0]
  if (!updated) return null
  await retentionAudit(db, {
    ...context,
    clientId: context.clientId ?? before.client_id,
    documentId: context.documentId ?? before.document_id,
    action: 'recording.retention_set',
    recordingId: before.id,
    detail: { previousStatus: before.source_delete_status, nextStatus: updated.source_delete_status, trigger: 'ai_complete', jobId },
  })
  return updated.source_delete_status as SourceDeleteStatus
}

export async function getRecordingRetention(db: Db | Tx, recordingId: string, officeId: string): Promise<RecordingRetentionState | null> {
  const row = (await db.query(
    `SELECT id, source_expires_at, source_deleted_at, source_delete_status, retention_policy_version,
            retention_hold, retention_hold_until, retention_hold_reason_code, retention_hold_set_at, retention_hold_set_by
       FROM recordings WHERE id = $1 AND office_id = $2`,
    [recordingId, officeId],
  )).rows[0]
  return row ? state(row) : null
}

function validateHoldUntil(holdUntil: Date) {
  if (!(holdUntil instanceof Date) || Number.isNaN(holdUntil.getTime()) || holdUntil.getTime() <= Date.now()) {
    throw new Error('retention_hold_until_must_be_future')
  }
}

function validateReasonCode(reasonCode: string) {
  if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(reasonCode)) throw new Error('invalid_retention_hold_reason_code')
}

export async function setRecordingRetentionHold(db: Db, recordingId: string, context: RecordingRetentionContext, holdUntil: Date, reasonCode: string) {
  validateHoldUntil(holdUntil)
  validateReasonCode(reasonCode)
  return tx(db, async (c) => {
    const before = (await c.query(
      'SELECT id, client_id, document_id, source_delete_status FROM recordings WHERE id = $1 AND office_id = $2 FOR UPDATE',
      [recordingId, context.officeId],
    )).rows[0]
    if (!before) throw new Error('recording_not_found')
    if (before.source_delete_status === 'deleted') throw new Error('recording_already_deleted')
    const updated = (await c.query(
      `UPDATE recordings
          SET retention_hold = true, retention_hold_until = $3, retention_hold_reason_code = $4,
              retention_hold_set_at = now(), retention_hold_set_by = $5, source_delete_status = 'pending'
        WHERE id = $1 AND office_id = $2
        RETURNING id, source_delete_status`,
      [recordingId, context.officeId, holdUntil, reasonCode, context.actorStaffId ?? null],
    )).rows[0]
    await retentionAudit(c, {
      ...context,
      clientId: context.clientId ?? before.client_id,
      documentId: context.documentId ?? before.document_id,
      action: 'recording.retention_hold_set',
      recordingId,
      detail: { previousStatus: before.source_delete_status, nextStatus: updated.source_delete_status, reasonCode },
    })
    return updated.source_delete_status as SourceDeleteStatus
  })
}

export async function releaseRecordingRetentionHold(db: Db, recordingId: string, context: RecordingRetentionContext) {
  return tx(db, async (c) => releaseRecordingRetentionHoldInTx(c, recordingId, context, 'manual'))
}

async function releaseRecordingRetentionHoldInTx(c: Tx, recordingId: string, context: RecordingRetentionContext, trigger: 'manual' | 'expired') {
  const before = (await c.query(
    `SELECT id, client_id, document_id, source_delete_status, retention_hold
       FROM recordings WHERE id = $1 AND office_id = $2 FOR UPDATE`,
    [recordingId, context.officeId],
  )).rows[0]
  if (!before) throw new Error('recording_not_found')
  if (!before.retention_hold) return false
  const updated = (await c.query(
    `UPDATE recordings
        SET retention_hold = false, retention_hold_until = NULL, retention_hold_reason_code = NULL,
            retention_hold_set_at = NULL, retention_hold_set_by = NULL,
            source_delete_status = CASE WHEN source_expires_at <= now() THEN 'eligible' ELSE 'pending' END
      WHERE id = $1 AND office_id = $2
      RETURNING source_delete_status`,
    [recordingId, context.officeId],
  )).rows[0]
  await retentionAudit(c, {
    ...context,
    clientId: context.clientId ?? before.client_id,
    documentId: context.documentId ?? before.document_id,
    action: 'recording.retention_hold_released',
    recordingId,
    detail: { previousStatus: before.source_delete_status, nextStatus: updated.source_delete_status, trigger },
  })
  return true
}

export async function releaseExpiredRecordingRetentionHolds(db: Db, limit = 100) {
  return tx(db, async (c) => {
    const rows = (await c.query(
      `SELECT id, office_id, client_id, document_id FROM recordings
        WHERE retention_hold = true AND retention_hold_until <= now()
        ORDER BY retention_hold_until LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    )).rows
    for (const row of rows) await releaseRecordingRetentionHoldInTx(c, row.id, {
      officeId: row.office_id, clientId: row.client_id, documentId: row.document_id,
      auditContext: { source: 'scheduler' },
    }, 'expired')
    return rows.length
  })
}

export async function markExpiredSourceRecordingsEligible(db: Db, limit = 100) {
  await releaseExpiredRecordingRetentionHolds(db, limit)
  const result = await db.query(
    `UPDATE recordings
        SET source_delete_status = 'eligible'
      WHERE id IN (
        SELECT id FROM recordings
         WHERE source_delete_status = 'pending' AND source_expires_at <= now()
           AND retention_hold = false AND source_deleted_at IS NULL
         ORDER BY source_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
      )
      RETURNING id`,
    [limit],
  )
  return result.rows.map((row) => row.id as string)
}

export async function listExpiredSourceRecordings(db: Db, limit = 100): Promise<RecordingRetentionState[]> {
  const rows = (await db.query(
    `SELECT id, source_expires_at, source_deleted_at, source_delete_status, retention_policy_version,
            retention_hold, retention_hold_until, retention_hold_reason_code, retention_hold_set_at, retention_hold_set_by
       FROM recordings
      WHERE source_delete_status = 'eligible' AND source_expires_at <= now()
        AND retention_hold = false AND source_deleted_at IS NULL
      ORDER BY source_expires_at, id LIMIT $1`,
    [limit],
  )).rows
  return rows.map(state)
}
