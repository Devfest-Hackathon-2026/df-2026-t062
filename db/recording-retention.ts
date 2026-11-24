import { randomUUID } from 'node:crypto'
import { writeBusinessAudit, writeBusinessAuditBatch, type AuditContext } from './audit.ts'
import { tx, type Db, type Tx } from './pool.ts'
import { decimalString, type DecimalString, type SourceObjectErrorCode } from '../storage/source-object-control.ts'

export const RECORDING_RETENTION_POLICY_VERSION = 'recording-retention-v2'
export const RECORDING_MAX_RETENTION_DAYS = 14
export const RECORDING_HOLD_MAX_DAYS = 90
export const RECORDING_DELETE_LEASE_MINUTES = 15
export const RECORDING_DELETE_MAX_ATTEMPTS = 6
export const SOURCE_SOFT_DELETE_RETENTION_SECONDS = 3 * 24 * 60 * 60
export const INTERMEDIATE_RETENTION_DAYS = 14
export const INTERMEDIATE_DELETE_LEASE_MINUTES = 15

export const SOURCE_DELETE_STATUSES = ['pending', 'eligible', 'requested', 'deleting', 'deleted', 'failed'] as const
export type SourceDeleteStatus = typeof SOURCE_DELETE_STATUSES[number]
export const RETENTION_HOLD_SYNC_STATUSES = ['legacy', 'synced', 'applying', 'releasing', 'failed'] as const
export type RetentionHoldSyncStatus = typeof RETENTION_HOLD_SYNC_STATUSES[number]
export const HOLD_REASON_CODES = [
  'legal_request', 'incident_investigation', 'security_investigation', 'regulatory_request',
  'renewed_legal_request', 'temporary_investigation',
  'too_late',
] as const
export type HoldReasonCode = typeof HOLD_REASON_CODES[number]

const holdReasonCodes = new Set<string>(HOLD_REASON_CODES)
const DELETE_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const
const HOLD_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const

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
  sourcePurgeExpectedAt: string | null
  intermediateExpiresAt: string
  intermediateDeleteStatus: 'pending' | 'deleting' | 'deleted' | 'failed'
  intermediateDeletedAt: string | null
  retentionPolicyVersion: string
  retentionHold: boolean
  retentionHoldTarget: boolean
  retentionHoldSyncStatus: RetentionHoldSyncStatus
  retentionHoldOperationVersion: DecimalString
  retentionHoldUntil: string | null
  retentionHoldReasonCode: HoldReasonCode | null
  retentionHoldSetAt: string | null
  retentionHoldSetBy: string | null
}

export interface RecordingDeletionCandidate {
  recordingId: string
  officeId: string
  clientId: string
  documentId: string
  objectPath: string
  sourceExpiresAt: string
  sourceDeleteStatus: 'requested' | 'deleting'
  generation?: DecimalString
  claimToken?: string
  attempts?: number
}

export interface ClaimedDeletionCandidate extends RecordingDeletionCandidate {
  sourceDeleteStatus: 'deleting'
  generation: DecimalString
  claimToken: string
  attempts: number
}

export interface ClaimedIntermediateDeletionCandidate {
  recordingId: string
  officeId: string
  clientId: string
  documentId: string
  intermediateExpiresAt: string
  claimToken: string
  attempts: number
}

export interface HoldSyncCandidate {
  recordingId: string
  officeId: string
  clientId: string
  documentId: string
  objectPath: string
  generation: DecimalString | null
  metageneration: DecimalString | null
  target: boolean
  operationVersion: DecimalString
  claimToken: string
  attempts: number
}

export interface RecordingRetentionObservability {
  overdueCount: number
  eligibleStuckCount: number
  deletingStuckCount: number
  failedPastRetryCount: number
  finalFailureCount: number
  unsyncedHoldCount: number
  escalatedHoldCount: number
  intermediateOverdueCount: number
  intermediateMissingExpiryCount: number
  intermediateStuckCount: number
  intermediateFailedPastRetryCount: number
  intermediateFinalFailureCount: number
}

export interface RetentionHoldVerificationCandidate {
  recordingId: string
  objectPath: string
  expectedHold: boolean
  generation: DecimalString
}

const iso = (value: unknown) => value ? new Date(value as string | Date).toISOString() : null

function state(row: Record<string, unknown>): RecordingRetentionState {
  return {
    recordingId: row.id as string,
    sourceExpiresAt: new Date(row.source_expires_at as string).toISOString(),
    sourceDeletedAt: iso(row.source_deleted_at),
    sourceDeleteStatus: row.source_delete_status as SourceDeleteStatus,
    sourcePurgeExpectedAt: iso(row.source_purge_expected_at),
    intermediateExpiresAt: new Date(row.intermediate_expires_at as string).toISOString(),
    intermediateDeleteStatus: row.intermediate_delete_status as RecordingRetentionState['intermediateDeleteStatus'],
    intermediateDeletedAt: iso(row.intermediate_deleted_at),
    retentionPolicyVersion: row.retention_policy_version as string,
    retentionHold: row.retention_hold as boolean,
    retentionHoldTarget: row.retention_hold_target as boolean,
    retentionHoldSyncStatus: row.retention_hold_sync_status as RetentionHoldSyncStatus,
    retentionHoldOperationVersion: decimalString(row.retention_hold_operation_version),
    retentionHoldUntil: iso(row.retention_hold_until),
    retentionHoldReasonCode: row.retention_hold_reason_code as HoldReasonCode | null,
    retentionHoldSetAt: iso(row.retention_hold_set_at),
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
  const before = (await db.query('SELECT source_delete_status FROM recordings WHERE id = $1 AND office_id = $2 FOR UPDATE', [recordingId, context.officeId])).rows[0]
  if (!before) throw new Error('recording_not_found')
  const updated = (await db.query(
    `UPDATE recordings
        SET source_expires_at = recorded_at + make_interval(days => $3),
            intermediate_expires_at = recorded_at + make_interval(days => $3),
            retention_policy_version = $4,
            source_delete_status = CASE
              WHEN retention_hold OR retention_hold_target OR retention_hold_sync_status <> 'synced' THEN 'pending'
              WHEN recorded_at + make_interval(days => $3) <= now() THEN 'eligible'
              ELSE 'pending'
            END
      WHERE id = $1 AND office_id = $2 AND source_delete_status IN ('pending', 'eligible')
      RETURNING id, source_delete_status`,
    [recordingId, context.officeId, RECORDING_MAX_RETENTION_DAYS, RECORDING_RETENTION_POLICY_VERSION],
  )).rows[0]
  if (!updated) return null
  await retentionAudit(db, { ...context, action: 'recording.retention_set', recordingId, detail: {
    previousStatus: before.source_delete_status, nextStatus: updated.source_delete_status, trigger: 'recording_complete',
  } })
  return updated.source_delete_status as SourceDeleteStatus
}

export async function claimIntermediateDeletionCandidates(
  db: Db,
  limit = 100,
  retryFailed = false,
): Promise<ClaimedIntermediateDeletionCandidate[]> {
  const token = randomUUID()
  const rows = (await db.query(
    `WITH candidates AS (
       SELECT id
         FROM recordings
        WHERE intermediate_expires_at <= now()
          AND intermediate_deleted_at IS NULL
          AND NOT retention_hold
          AND NOT retention_hold_target
          AND (
            (intermediate_delete_status = 'pending')
            OR (intermediate_delete_status = 'failed' AND ($3::boolean OR intermediate_delete_next_retry_at <= now()))
            OR (intermediate_delete_status = 'deleting' AND intermediate_delete_claimed_at <= now() - interval '${INTERMEDIATE_DELETE_LEASE_MINUTES} minutes')
          )
          AND NOT EXISTS (
            SELECT 1 FROM jobs j
             WHERE j.recording_id = recordings.id AND j.status IN ('queued', 'processing')
          )
        ORDER BY intermediate_expires_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
    )
    UPDATE recordings r
       SET intermediate_delete_status = 'deleting',
           intermediate_delete_claim_token = $2,
           intermediate_delete_claimed_at = now(),
           intermediate_delete_last_attempt_at = now(),
           intermediate_delete_attempts = intermediate_delete_attempts + 1,
           intermediate_delete_next_retry_at = NULL,
           intermediate_delete_last_error_code = NULL
      FROM candidates c
     WHERE r.id = c.id
     RETURNING r.id, r.office_id, r.client_id, r.document_id, r.intermediate_expires_at, r.intermediate_delete_attempts`,
    [limit, token, retryFailed],
  )).rows
  return rows.map((row) => ({
    recordingId: row.id,
    officeId: row.office_id,
    clientId: row.client_id,
    documentId: row.document_id,
    intermediateExpiresAt: new Date(row.intermediate_expires_at).toISOString(),
    claimToken: token,
    attempts: row.intermediate_delete_attempts,
  }))
}

export async function markIntermediateDataDeleted(db: Db, candidate: ClaimedIntermediateDeletionCandidate) {
  return tx(db, async (c) => {
    const claimed = (await c.query(
      `SELECT office_id, client_id, document_id
         FROM recordings
        WHERE id = $1 AND intermediate_delete_status = 'deleting'
          AND intermediate_delete_claim_token = $2
        FOR UPDATE`,
      [candidate.recordingId, candidate.claimToken],
    )).rows[0]
    if (!claimed) return false
    const transcripts = (await c.query(
      'DELETE FROM transcripts WHERE recording_id = $1 RETURNING recording_id',
      [candidate.recordingId],
    )).rowCount ?? 0
    const summaries = (await c.query(
      'DELETE FROM recording_summaries WHERE recording_id = $1 RETURNING id',
      [candidate.recordingId],
    )).rowCount ?? 0
    const draftRedactions = (await c.query(
      `UPDATE care_record_drafts
          SET source = jsonb_set(
            source,
            '{recordings}',
            COALESCE(
              (SELECT jsonb_agg(CASE WHEN recording->>'id' = $1::text THEN recording - 'utterances' ELSE recording END)
                 FROM jsonb_array_elements(COALESCE(source->'recordings', '[]'::jsonb)) AS recording),
              '[]'::jsonb
            )
          )
        WHERE source->'recordings' @> jsonb_build_array(jsonb_build_object('id', $1::text))
        RETURNING id`,
      [candidate.recordingId],
    )).rowCount ?? 0
    const row = (await c.query(
      `UPDATE recordings
          SET intermediate_delete_status = 'deleted',
              intermediate_deleted_at = now(),
              intermediate_delete_claim_token = NULL,
              intermediate_delete_claimed_at = NULL,
              intermediate_delete_next_retry_at = NULL,
              intermediate_delete_last_error_code = NULL
        WHERE id = $1 AND intermediate_delete_status = 'deleting' AND intermediate_delete_claim_token = $2
        RETURNING office_id, client_id, document_id, intermediate_deleted_at`,
      [candidate.recordingId, candidate.claimToken],
    )).rows[0]
    if (!row) return false
    await retentionAudit(c, {
      officeId: row.office_id,
      clientId: row.client_id,
      documentId: row.document_id,
      auditContext: { source: 'scheduler' },
      action: 'recording.intermediate_deleted',
      recordingId: candidate.recordingId,
      detail: {
        intermediateDeletedAt: new Date(row.intermediate_deleted_at).toISOString(),
        textRecordCount: transcripts,
        summaryCount: summaries,
        draftRedactionCount: draftRedactions,
      },
    })
    return { transcripts, summaries }
  })
}

export async function markIntermediateDataDeleteFailed(
  db: Db,
  candidate: ClaimedIntermediateDeletionCandidate,
  errorCode: 'database_error',
  retryable: boolean,
) {
  const retryAt = retryable && candidate.attempts < RECORDING_DELETE_MAX_ATTEMPTS
    ? new Date(Date.now() + DELETE_RETRY_DELAYS_MS[Math.min(candidate.attempts - 1, DELETE_RETRY_DELAYS_MS.length - 1)]!)
    : null
  const row = (await db.query(
    `UPDATE recordings
        SET intermediate_delete_status = 'failed',
            intermediate_delete_claim_token = NULL,
            intermediate_delete_claimed_at = NULL,
            intermediate_delete_last_error_code = $3,
            intermediate_delete_next_retry_at = $4
      WHERE id = $1 AND intermediate_delete_status = 'deleting' AND intermediate_delete_claim_token = $2
      RETURNING id`,
    [candidate.recordingId, candidate.claimToken, errorCode, retryAt],
  )).rows[0]
  return Boolean(row)
}

export async function getRecordingRetention(db: Db | Tx, recordingId: string, officeId: string): Promise<RecordingRetentionState | null> {
  const row = (await db.query(
    `SELECT id, source_expires_at, source_deleted_at, source_delete_status, source_purge_expected_at,
            intermediate_expires_at, intermediate_delete_status, intermediate_deleted_at, retention_policy_version,
            retention_hold, retention_hold_target, retention_hold_sync_status, retention_hold_operation_version,
            retention_hold_until, retention_hold_reason_code, retention_hold_set_at, retention_hold_set_by
       FROM recordings WHERE id = $1 AND office_id = $2`,
    [recordingId, officeId],
  )).rows[0]
  return row ? state(row) : null
}

function validateHold(holdUntil: Date, reasonCode: string, now = new Date()) {
  if (!(holdUntil instanceof Date) || Number.isNaN(holdUntil.getTime()) || holdUntil.getTime() <= now.getTime()
    || holdUntil.getTime() > now.getTime() + RECORDING_HOLD_MAX_DAYS * 24 * 60 * 60 * 1000) {
    throw new Error('invalid_hold_until')
  }
  if (!holdReasonCodes.has(reasonCode)) throw new Error('invalid_hold_reason_code')
}

export async function requestRecordingRetentionHold(
  db: Db,
  recordingId: string,
  context: RecordingRetentionContext,
  holdUntil: Date,
  reasonCode: HoldReasonCode,
) {
  const now = new Date()
  validateHold(holdUntil, reasonCode, now)
  return tx(db, async (c) => {
    const before = (await c.query(
      `SELECT id, client_id, document_id, source_delete_status, retention_hold, retention_hold_target,
              retention_hold_sync_status, retention_hold_operation_version
         FROM recordings WHERE id = $1 AND office_id = $2 FOR UPDATE`,
      [recordingId, context.officeId],
    )).rows[0]
    if (!before) throw new Error('recording_not_found')
    if (before.source_delete_status === 'deleted') throw new Error('recording_source_deleted')
    if (before.source_delete_status === 'deleting') throw new Error('recording_source_deleting')
    const updated = (await c.query(
      `UPDATE recordings
          SET retention_hold_target = true,
              retention_hold_sync_status = 'applying',
              retention_hold_operation_version = retention_hold_operation_version + 1,
              retention_hold_until = $3,
              retention_hold_reason_code = $4,
              retention_hold_set_at = $5,
              retention_hold_set_by = $6,
              retention_hold_sync_attempts = 0,
              retention_hold_sync_claim_token = NULL,
              retention_hold_sync_claimed_at = NULL,
              retention_hold_sync_next_retry_at = now(),
              retention_hold_sync_last_error_code = NULL,
              retention_hold_sync_escalated_at = NULL,
              source_delete_status = 'pending',
              source_delete_claim_token = NULL,
              source_delete_claimed_at = NULL
        WHERE id = $1 AND office_id = $2
        RETURNING retention_hold_operation_version`,
      [recordingId, context.officeId, holdUntil, reasonCode, now, context.actorStaffId ?? null],
    )).rows[0]
    await retentionAudit(c, { ...context, clientId: context.clientId ?? before.client_id, documentId: context.documentId ?? before.document_id,
      action: 'recording.retention_hold_requested', recordingId,
      detail: { previousStatus: before.source_delete_status, holdUntil: holdUntil.toISOString(), reasonCode,
        operationVersion: String(updated.retention_hold_operation_version) },
    })
    return getRecordingRetention(c, recordingId, context.officeId)
  })
}

/** PR3のDBヘルパー互換。PR4のAPIはrequestRecordingRetentionHoldを使い、GCS同期前に確定しない。 */
export async function setRecordingRetentionHold(db: Db, recordingId: string, context: RecordingRetentionContext, holdUntil: Date, reasonCode: string) {
  if (!(holdUntil instanceof Date) || Number.isNaN(holdUntil.getTime()) || holdUntil.getTime() <= Date.now()) throw new Error('retention_hold_until_must_be_future')
  return tx(db, async (c) => {
    const before = (await c.query(
      `SELECT id, client_id, document_id, source_delete_status, retention_hold FROM recordings WHERE id = $1 AND office_id = $2 FOR UPDATE`,
      [recordingId, context.officeId],
    )).rows[0]
    if (!before) throw new Error('recording_not_found')
    if (before.source_delete_status === 'deleting' || before.source_delete_status === 'deleted') throw new Error('recording_deletion_in_progress')
    await c.query(
      `UPDATE recordings SET retention_hold = true, retention_hold_target = true, retention_hold_sync_status = 'synced',
          retention_hold_until = $3, retention_hold_reason_code = $4, retention_hold_set_at = now(), retention_hold_set_by = $5,
          source_delete_status = 'pending' WHERE id = $1 AND office_id = $2`,
      [recordingId, context.officeId, holdUntil, reasonCode, context.actorStaffId ?? null],
    )
    await retentionAudit(c, { ...context, clientId: context.clientId ?? before.client_id, documentId: context.documentId ?? before.document_id,
      action: 'recording.retention_hold_set', recordingId,
      detail: { previousStatus: before.source_delete_status, nextStatus: 'pending', previousHoldState: before.retention_hold ? 'active' : 'inactive', holdState: 'active', holdUntil: holdUntil.toISOString(), reasonCode },
    })
    return 'pending' as SourceDeleteStatus
  })
}

export async function requestRecordingRetentionHoldRelease(db: Db, recordingId: string, context: RecordingRetentionContext, trigger: 'manual' | 'expired' = 'manual') {
  return tx(db, async (c) => requestRecordingRetentionHoldReleaseInTx(c, recordingId, context, trigger))
}

async function requestRecordingRetentionHoldReleaseInTx(c: Tx, recordingId: string, context: RecordingRetentionContext, trigger: 'manual' | 'expired') {
  const before = (await c.query(
    `SELECT id, client_id, document_id, source_delete_status, retention_hold, retention_hold_target,
            retention_hold_sync_status, retention_hold_until, retention_hold_reason_code
       FROM recordings WHERE id = $1 AND office_id = $2 FOR UPDATE`,
    [recordingId, context.officeId],
  )).rows[0]
  if (!before) throw new Error('recording_not_found')
  if (!before.retention_hold && !before.retention_hold_target) throw new Error('retention_hold_not_active')
  const updated = (await c.query(
    `UPDATE recordings
        SET retention_hold_target = false,
            retention_hold_sync_status = 'releasing',
            retention_hold_operation_version = retention_hold_operation_version + 1,
            retention_hold_sync_attempts = 0,
            retention_hold_sync_claim_token = NULL,
            retention_hold_sync_claimed_at = NULL,
            retention_hold_sync_next_retry_at = now(),
            retention_hold_sync_last_error_code = NULL,
            retention_hold_sync_escalated_at = NULL
      WHERE id = $1 AND office_id = $2
      RETURNING retention_hold_operation_version`,
    [recordingId, context.officeId],
  )).rows[0]
  await retentionAudit(c, { ...context, clientId: context.clientId ?? before.client_id, documentId: context.documentId ?? before.document_id,
    action: 'recording.retention_hold_release_requested', recordingId,
    detail: { trigger, holdUntil: iso(before.retention_hold_until), reasonCode: before.retention_hold_reason_code,
      operationVersion: String(updated.retention_hold_operation_version) },
  })
  return getRecordingRetention(c, recordingId, context.officeId)
}

/** PR3のDBヘルパー互換。本番の解除APIはrequestRecordingRetentionHoldReleaseを使う。 */
export async function releaseRecordingRetentionHold(db: Db, recordingId: string, context: RecordingRetentionContext) {
  return tx(db, async (c) => {
    const before = (await c.query(
      `SELECT id, client_id, document_id, source_delete_status, source_expires_at, retention_hold, retention_hold_until, retention_hold_reason_code
         FROM recordings WHERE id = $1 AND office_id = $2 FOR UPDATE`,
      [recordingId, context.officeId],
    )).rows[0]
    if (!before) throw new Error('recording_not_found')
    if (!before.retention_hold) return false
    const nextStatus = before.source_expires_at <= new Date() ? 'eligible' : 'pending'
    await c.query(
      `UPDATE recordings SET retention_hold = false, retention_hold_target = false, retention_hold_sync_status = 'synced',
          retention_hold_until = NULL, retention_hold_reason_code = NULL, retention_hold_set_at = NULL, retention_hold_set_by = NULL,
          source_delete_status = CASE WHEN source_expires_at <= now() THEN 'eligible' ELSE 'pending' END
        WHERE id = $1 AND office_id = $2`,
      [recordingId, context.officeId],
    )
    await retentionAudit(c, { ...context, clientId: context.clientId ?? before.client_id, documentId: context.documentId ?? before.document_id,
      action: 'recording.retention_hold_released', recordingId,
      detail: { previousStatus: before.source_delete_status, nextStatus: nextStatus, holdState: 'released', holdUntil: new Date(before.retention_hold_until).toISOString(), reasonCode: before.retention_hold_reason_code, trigger: 'manual' },
    })
    return true
  })
}

export async function releaseExpiredRecordingRetentionHolds(db: Db, limit = 100) {
  return tx(db, async (c) => {
    const rows = (await c.query(
      `SELECT id, office_id, client_id, document_id, retention_hold_until, retention_hold_reason_code FROM recordings
        WHERE retention_hold_target = true AND retention_hold_until <= now()
        ORDER BY retention_hold_until, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    )).rows
    for (const row of rows) {
      await c.query(
        `UPDATE recordings SET retention_hold = false, retention_hold_target = false, retention_hold_sync_status = 'synced',
            retention_hold_until = NULL, retention_hold_reason_code = NULL, retention_hold_set_at = NULL, retention_hold_set_by = NULL,
            source_delete_status = CASE WHEN source_expires_at <= now() THEN 'eligible' ELSE 'pending' END
          WHERE id = $1`,
        [row.id],
      )
      await retentionAudit(c, { officeId: row.office_id, clientId: row.client_id, documentId: row.document_id, auditContext: { source: 'scheduler' },
        action: 'recording.retention_hold_released', recordingId: row.id,
        detail: { holdState: 'released', trigger: 'expired', holdUntil: iso(row.retention_hold_until), reasonCode: row.retention_hold_reason_code },
      })
    }
    return rows.length
  })
}

async function requestExpiredRecordingRetentionHolds(db: Db, limit = 100) {
  return tx(db, async (c) => {
    const rows = (await c.query(
      `SELECT id, office_id, client_id, document_id FROM recordings
        WHERE retention_hold_target = true AND retention_hold_until <= now()
        ORDER BY retention_hold_until, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    )).rows
    for (const row of rows) await requestRecordingRetentionHoldReleaseInTx(c, row.id, {
      officeId: row.office_id, clientId: row.client_id, documentId: row.document_id, auditContext: { source: 'scheduler' },
    }, 'expired')
    return rows.length
  })
}

export async function adoptLegacyRecordingRetention(db: Db, limit = 100) {
  const rows = (await db.query(
    `WITH candidates AS (
       SELECT id FROM recordings WHERE retention_hold_sync_status = 'legacy' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE recordings r
        SET retention_hold_target = r.retention_hold,
            retention_hold_sync_status = CASE WHEN r.retention_hold THEN 'applying' ELSE 'synced' END,
            retention_hold_sync_next_retry_at = CASE WHEN r.retention_hold THEN now() ELSE NULL END
       FROM candidates c WHERE r.id = c.id
     RETURNING r.id`,
    [limit],
  )).rows
  return rows.map((row) => row.id as string)
}

export async function claimRetentionHoldSyncCandidates(db: Db, limit = 100): Promise<HoldSyncCandidate[]> {
  await adoptLegacyRecordingRetention(db, limit)
  const claimToken = randomUUID()
  const rows = (await db.query(
    `WITH candidates AS (
       SELECT id FROM recordings
        WHERE retention_hold_sync_status IN ('applying', 'releasing', 'failed')
          AND (retention_hold_sync_next_retry_at IS NULL OR retention_hold_sync_next_retry_at <= now())
          AND (retention_hold_sync_claimed_at IS NULL OR retention_hold_sync_claimed_at <= now() - interval '15 minutes')
        ORDER BY coalesce(retention_hold_sync_next_retry_at, '-infinity'), id
        LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE recordings r
        SET retention_hold_sync_claim_token = $2,
            retention_hold_sync_claimed_at = now(),
            retention_hold_sync_last_attempt_at = now(),
            retention_hold_sync_attempts = retention_hold_sync_attempts + 1
       FROM candidates c WHERE r.id = c.id
     RETURNING r.id, r.office_id, r.client_id, r.document_id, r.object_path,
               r.source_generation, r.source_metageneration, r.retention_hold_target,
               r.retention_hold_operation_version, r.retention_hold_sync_attempts`,
    [limit, claimToken],
  )).rows
  return rows.map((row) => ({
    recordingId: row.id, officeId: row.office_id, clientId: row.client_id, documentId: row.document_id,
    objectPath: row.object_path,
    generation: row.source_generation === null ? null : decimalString(row.source_generation),
    metageneration: row.source_metageneration === null ? null : decimalString(row.source_metageneration),
    target: row.retention_hold_target, operationVersion: decimalString(row.retention_hold_operation_version),
    claimToken, attempts: row.retention_hold_sync_attempts,
  }))
}

export async function claimRetentionHoldSyncCandidate(db: Db, recordingId: string, operationVersion: DecimalString): Promise<HoldSyncCandidate | null> {
  const claimToken = randomUUID()
  const row = (await db.query(
    `UPDATE recordings
        SET retention_hold_sync_claim_token = $3,
            retention_hold_sync_claimed_at = now(),
            retention_hold_sync_last_attempt_at = now(),
            retention_hold_sync_attempts = retention_hold_sync_attempts + 1
      WHERE id = $1 AND retention_hold_operation_version = $2
        AND retention_hold_sync_status IN ('applying', 'releasing', 'failed')
        AND (retention_hold_sync_claimed_at IS NULL OR retention_hold_sync_claimed_at <= now() - interval '15 minutes')
      RETURNING id, office_id, client_id, document_id, object_path, source_generation, source_metageneration,
                retention_hold_target, retention_hold_operation_version, retention_hold_sync_attempts`,
    [recordingId, operationVersion, claimToken],
  )).rows[0]
  return row ? {
    recordingId: row.id, officeId: row.office_id, clientId: row.client_id, documentId: row.document_id,
    objectPath: row.object_path,
    generation: row.source_generation === null ? null : decimalString(row.source_generation),
    metageneration: row.source_metageneration === null ? null : decimalString(row.source_metageneration),
    target: row.retention_hold_target, operationVersion: decimalString(row.retention_hold_operation_version),
    claimToken, attempts: row.retention_hold_sync_attempts,
  } : null
}

export async function storeRecordingSourceMetadata(
  db: Db | Tx,
  recordingId: string,
  metadata: { generation: DecimalString, metageneration: DecimalString },
  condition: { holdClaimToken?: string, holdOperationVersion?: DecimalString, uploadCancelClaimToken?: string } = {},
) {
  const values: unknown[] = [recordingId, metadata.generation, metadata.metageneration]
  const predicates = ['id = $1']
  if (condition.holdClaimToken) {
    values.push(condition.holdClaimToken)
    predicates.push(`retention_hold_sync_claim_token = $${values.length}`)
  }
  if (condition.holdOperationVersion) {
    values.push(condition.holdOperationVersion)
    predicates.push(`retention_hold_operation_version = $${values.length}`)
  }
  if (condition.uploadCancelClaimToken) {
    values.push(condition.uploadCancelClaimToken)
    predicates.push(`upload_cancel_claim_token = $${values.length}`)
  }
  const result = await db.query(
    `UPDATE recordings SET source_generation = $2, source_metageneration = $3 WHERE ${predicates.join(' AND ')} RETURNING id`,
    values,
  )
  return result.rowCount === 1
}

export async function completeRetentionHoldSync(
  db: Db,
  candidate: HoldSyncCandidate,
  metadata: { generation: DecimalString, metageneration: DecimalString },
) {
  return tx(db, async (c) => {
    const row = (await c.query(
      `UPDATE recordings
          SET source_generation = $5,
              source_metageneration = $6,
              retention_hold = $4,
              retention_hold_sync_status = 'synced',
              retention_hold_sync_claim_token = NULL,
              retention_hold_sync_claimed_at = NULL,
              retention_hold_sync_next_retry_at = NULL,
              retention_hold_sync_last_error_code = NULL,
              retention_hold_sync_escalated_at = NULL,
              retention_hold_until = CASE WHEN $4 THEN retention_hold_until ELSE NULL END,
              retention_hold_reason_code = CASE WHEN $4 THEN retention_hold_reason_code ELSE NULL END,
              retention_hold_set_at = CASE WHEN $4 THEN retention_hold_set_at ELSE NULL END,
              retention_hold_set_by = CASE WHEN $4 THEN retention_hold_set_by ELSE NULL END,
              source_delete_status = CASE WHEN $4 THEN 'pending' WHEN source_expires_at <= now() THEN 'eligible' ELSE 'pending' END
        WHERE id = $1 AND retention_hold_sync_claim_token = $2
          AND retention_hold_operation_version = $3 AND retention_hold_target = $4
        RETURNING office_id, client_id, document_id, source_delete_status`,
      [candidate.recordingId, candidate.claimToken, candidate.operationVersion, candidate.target, metadata.generation, metadata.metageneration],
    )).rows[0]
    if (!row) return false
    await retentionAudit(c, { officeId: row.office_id, clientId: row.client_id, documentId: row.document_id,
      auditContext: { source: 'worker' }, action: candidate.target ? 'recording.retention_hold_synced' : 'recording.retention_hold_released',
      recordingId: candidate.recordingId,
      detail: { holdState: candidate.target ? 'active' : 'released', operationVersion: candidate.operationVersion, nextStatus: row.source_delete_status },
    })
    return true
  })
}

export async function failRetentionHoldSync(db: Db, candidate: HoldSyncCandidate, errorCode: SourceObjectErrorCode | 'object_missing' | 'generation_mismatch') {
  const retryAt = new Date(Date.now() + (HOLD_RETRY_DELAYS_MS[Math.min(candidate.attempts - 1, HOLD_RETRY_DELAYS_MS.length - 1)] ?? 6 * 60 * 60_000))
  const row = (await db.query(
    `UPDATE recordings
        SET retention_hold_sync_status = 'failed',
            retention_hold_sync_claim_token = NULL,
            retention_hold_sync_claimed_at = NULL,
            retention_hold_sync_next_retry_at = $5,
            retention_hold_sync_last_error_code = $4,
            retention_hold_sync_escalated_at = CASE WHEN retention_hold_sync_attempts >= $6 THEN coalesce(retention_hold_sync_escalated_at, now()) ELSE retention_hold_sync_escalated_at END
      WHERE id = $1 AND retention_hold_sync_claim_token = $2 AND retention_hold_operation_version = $3
      RETURNING id`,
    [candidate.recordingId, candidate.claimToken, candidate.operationVersion, errorCode, retryAt, RECORDING_DELETE_MAX_ATTEMPTS],
  )).rows[0]
  return Boolean(row)
}

export async function markExpiredSourceRecordingsEligible(db: Db, limit = 100) {
  await requestExpiredRecordingRetentionHolds(db, limit)
  const result = await db.query(
    `UPDATE recordings SET source_delete_status = 'eligible'
      WHERE id IN (
        SELECT id FROM recordings
         WHERE source_delete_status = 'pending' AND source_expires_at <= now()
           AND retention_hold = false AND retention_hold_target = false
           AND retention_hold_sync_status = 'synced' AND source_deleted_at IS NULL
         ORDER BY source_expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
      ) RETURNING id`,
    [limit],
  )
  return result.rows.map((row) => row.id as string)
}

export async function claimExpiredSourceRecordings(db: Db, limit = 100): Promise<RecordingDeletionCandidate[]> {
  await markExpiredSourceRecordingsEligible(db, limit)
  return tx(db, async (c) => {
    const rows = (await c.query(
      `WITH candidates AS (
         SELECT id, source_delete_status AS previous_status FROM recordings
          WHERE source_delete_status IN ('eligible', 'requested') AND source_expires_at <= now()
            AND retention_hold = false AND retention_hold_target = false AND retention_hold_sync_status = 'synced'
            AND source_deleted_at IS NULL
          ORDER BY source_expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE recordings r SET source_delete_status = 'requested'
         FROM candidates c WHERE r.id = c.id
       RETURNING r.id, r.office_id, r.client_id, r.document_id, r.object_path, r.source_expires_at,
                 r.source_delete_status, r.source_generation, c.previous_status`,
      [limit],
    )).rows
    await writeBusinessAuditBatch(c, rows.filter((row) => row.previous_status !== 'requested').map((row) => ({
      officeId: row.office_id, action: 'recording.delete_requested', ids: { clientId: row.client_id, documentId: row.document_id },
      detail: { recordingId: row.id, policyVersion: RECORDING_RETENTION_POLICY_VERSION,
        previousStatus: row.previous_status, nextStatus: row.source_delete_status }, context: { source: 'scheduler' },
    })))
    return rows.map((row) => ({
      recordingId: row.id, officeId: row.office_id, clientId: row.client_id, documentId: row.document_id,
      objectPath: row.object_path, sourceExpiresAt: new Date(row.source_expires_at).toISOString(), sourceDeleteStatus: 'requested',
      generation: row.source_generation === null ? undefined : decimalString(row.source_generation),
    }))
  })
}

export async function beginSourceDeletion(db: Db, recordingId: string, officeId: string): Promise<RecordingDeletionCandidate | null> {
  const token = randomUUID()
  const row = (await db.query(
    `UPDATE recordings SET source_delete_status = 'deleting', source_delete_claim_token = $3,
                           source_delete_claimed_at = now(), source_delete_last_attempt_at = now(),
                           source_delete_attempts = source_delete_attempts + 1, source_delete_next_retry_at = NULL
      WHERE id = $1 AND office_id = $2 AND source_delete_status = 'requested'
        AND retention_hold = false AND retention_hold_target = false AND retention_hold_sync_status = 'synced'
        AND source_deleted_at IS NULL
      RETURNING id, office_id, client_id, document_id, object_path, source_expires_at, source_delete_status,
                source_generation, source_delete_attempts`,
    [recordingId, officeId, token],
  )).rows[0]
  return row ? {
    recordingId: row.id, officeId: row.office_id, clientId: row.client_id, documentId: row.document_id,
    objectPath: row.object_path, sourceExpiresAt: new Date(row.source_expires_at).toISOString(), sourceDeleteStatus: 'deleting',
    generation: row.source_generation === null ? undefined : decimalString(row.source_generation), claimToken: token, attempts: row.source_delete_attempts,
  } : null
}

export async function claimRecordingDeletionCandidates(db: Db, limit = 100): Promise<ClaimedDeletionCandidate[]> {
  await markExpiredSourceRecordingsEligible(db, limit)
  const token = randomUUID()
  const rows = (await db.query(
    `WITH candidates AS (
       SELECT id, source_delete_status AS previous_status FROM recordings
        WHERE source_generation IS NOT NULL AND source_deleted_at IS NULL
          AND retention_hold = false AND retention_hold_target = false AND retention_hold_sync_status = 'synced'
          AND (
            (source_delete_status IN ('eligible', 'requested') AND source_expires_at <= now())
            OR (source_delete_status = 'failed' AND source_delete_next_retry_at <= now())
            OR (source_delete_status = 'deleting' AND source_delete_claimed_at <= now() - interval '15 minutes')
          )
        ORDER BY source_expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE recordings r
        SET source_delete_status = 'deleting', source_delete_claim_token = $2, source_delete_claimed_at = now(),
            source_delete_last_attempt_at = now(), source_delete_attempts = source_delete_attempts + 1,
            source_delete_next_retry_at = NULL, source_delete_last_error_code = NULL
       FROM candidates c WHERE r.id = c.id
     RETURNING r.id, r.office_id, r.client_id, r.document_id, r.object_path, r.source_expires_at,
               r.source_generation, r.source_delete_attempts, c.previous_status`,
    [limit, token],
  )).rows
  await writeBusinessAuditBatch(db, rows.filter((row) => row.previous_status === 'eligible').map((row) => ({
    officeId: row.office_id, action: 'recording.delete_requested', ids: { clientId: row.client_id, documentId: row.document_id },
    detail: { recordingId: row.id, policyVersion: RECORDING_RETENTION_POLICY_VERSION, previousStatus: 'eligible', nextStatus: 'deleting' },
    context: { source: 'scheduler' },
  })))
  return rows.map((row) => ({
    recordingId: row.id, officeId: row.office_id, clientId: row.client_id, documentId: row.document_id,
    objectPath: row.object_path, sourceExpiresAt: new Date(row.source_expires_at).toISOString(), sourceDeleteStatus: 'deleting',
    generation: decimalString(row.source_generation), claimToken: token, attempts: row.source_delete_attempts,
  }))
}

export async function listRecordingGenerationBackfillCandidates(db: Db, limit = 100) {
  const rows = (await db.query(
    `SELECT id, object_path FROM recordings WHERE status = 'uploaded' AND source_generation IS NULL
      ORDER BY id LIMIT $1`,
    [limit],
  )).rows
  return rows.map((row) => ({ recordingId: row.id as string, objectPath: row.object_path as string }))
}

export async function markRecordingSourceDeleted(db: Db, candidate: ClaimedDeletionCandidate, softDeleteSeconds = SOURCE_SOFT_DELETE_RETENTION_SECONDS) {
  return tx(db, async (c) => {
    const row = (await c.query(
      `UPDATE recordings
          SET source_delete_status = 'deleted', source_deleted_at = now(),
              source_soft_delete_retention_seconds = $3,
              source_purge_expected_at = now() + make_interval(secs => $4),
              source_delete_claim_token = NULL, source_delete_claimed_at = NULL,
              source_delete_next_retry_at = NULL, source_delete_last_error_code = NULL
        WHERE id = $1 AND source_delete_status = 'deleting' AND source_delete_claim_token = $2
        RETURNING office_id, client_id, document_id, source_deleted_at, source_purge_expected_at`,
      [candidate.recordingId, candidate.claimToken, softDeleteSeconds, softDeleteSeconds],
    )).rows[0]
    if (!row) return false
    await retentionAudit(c, { officeId: row.office_id, clientId: row.client_id, documentId: row.document_id,
      auditContext: { source: 'scheduler' }, action: 'recording.source_deleted', recordingId: candidate.recordingId,
      detail: { sourceDeletedAt: new Date(row.source_deleted_at).toISOString(), purgeExpectedAt: new Date(row.source_purge_expected_at).toISOString(),
        softDeleteRetentionSeconds: softDeleteSeconds },
    })
    return true
  })
}

export async function markRecordingSourceDeleteFailed(
  db: Db,
  candidate: ClaimedDeletionCandidate,
  errorCode: SourceObjectErrorCode | 'generation_mismatch' | 'object_held',
  retryable: boolean,
) {
  const retryAt = retryable && candidate.attempts < RECORDING_DELETE_MAX_ATTEMPTS
    ? new Date(Date.now() + (DELETE_RETRY_DELAYS_MS[Math.min(candidate.attempts - 1, DELETE_RETRY_DELAYS_MS.length - 1)] ?? 24 * 60 * 60_000))
    : null
  const row = (await db.query(
    `UPDATE recordings
        SET source_delete_status = 'failed', source_delete_claim_token = NULL, source_delete_claimed_at = NULL,
            source_delete_last_error_code = $3, source_delete_next_retry_at = $4
      WHERE id = $1 AND source_delete_status = 'deleting' AND source_delete_claim_token = $2 RETURNING id`,
    [candidate.recordingId, candidate.claimToken, errorCode, retryAt],
  )).rows[0]
  return Boolean(row)
}

export async function lifecycleReadiness(db: Db) {
  const row = (await db.query(
    `SELECT
       count(*) FILTER (WHERE retention_hold_sync_status <> 'synced' AND (retention_hold OR retention_hold_target))::int AS unsynced_holds,
       count(*) FILTER (WHERE retention_hold_sync_escalated_at IS NOT NULL)::int AS escalated_holds,
       count(*) FILTER (WHERE source_deleted_at IS NULL AND source_expires_at IS NULL)::int AS missing_expiry,
       count(*) FILTER (WHERE source_deleted_at IS NOT NULL AND source_purge_expected_at IS NULL)::int AS missing_purge_expectation,
       count(*) FILTER (WHERE source_deleted_at IS NULL AND status = 'uploaded' AND source_generation IS NULL)::int AS missing_generation,
       count(*) FILTER (WHERE source_deleted_at IS NULL AND retention_hold_sync_status = 'legacy')::int AS legacy_hold_sync,
       count(*) FILTER (WHERE source_deleted_at IS NULL AND source_delete_status = 'failed')::int AS failed_deletions,
       count(*) FILTER (WHERE source_deleted_at IS NULL AND source_delete_status = 'deleting'
         AND source_delete_claimed_at <= now() - interval '15 minutes')::int AS stuck_deletions,
       count(*) FILTER (WHERE source_deleted_at IS NULL AND status IN ('uploading', 'abandoning')
         AND upload_started_at IS NOT NULL AND upload_started_at <= now() - interval '7 days')::int AS stale_uploads,
       count(*) FILTER (WHERE source_deleted_at IS NULL AND retention_hold_target AND retention_hold_until <= now())::int AS expired_active_holds,
       count(*) FILTER (WHERE intermediate_expires_at IS NULL)::int AS intermediate_missing_expiry,
       count(*) FILTER (WHERE intermediate_delete_status = 'failed')::int AS intermediate_failed_deletions,
       count(*) FILTER (WHERE intermediate_delete_status = 'deleting'
         AND intermediate_delete_claimed_at <= now() - interval '15 minutes')::int AS intermediate_stuck_deletions,
       count(*) FILTER (WHERE intermediate_delete_status = 'deleted' AND intermediate_deleted_at IS NULL)::int AS intermediate_deleted_state_mismatch,
       count(*) FILTER (WHERE intermediate_delete_status = 'failed'
         AND intermediate_delete_next_retry_at IS NOT NULL AND intermediate_delete_next_retry_at <= now())::int AS intermediate_failed_past_retry
     FROM recordings`,
  )).rows[0]
  return {
    unsyncedHolds: Number(row.unsynced_holds),
    escalatedHolds: Number(row.escalated_holds),
    missingExpiry: Number(row.missing_expiry),
    missingPurgeExpectation: Number(row.missing_purge_expectation),
    missingGeneration: Number(row.missing_generation),
    legacyHoldSync: Number(row.legacy_hold_sync),
    failedDeletions: Number(row.failed_deletions),
    stuckDeletions: Number(row.stuck_deletions),
    staleUploads: Number(row.stale_uploads),
    expiredActiveHolds: Number(row.expired_active_holds),
    intermediateMissingExpiry: Number(row.intermediate_missing_expiry),
    intermediateFailedDeletions: Number(row.intermediate_failed_deletions),
    intermediateStuckDeletions: Number(row.intermediate_stuck_deletions),
    intermediateDeletedStateMismatch: Number(row.intermediate_deleted_state_mismatch),
    intermediateFailedPastRetry: Number(row.intermediate_failed_past_retry),
  }
}

export async function getRecordingRetentionObservability(db: Db): Promise<RecordingRetentionObservability> {
  const row = (await db.query(
    `SELECT
       count(*) FILTER (WHERE source_deleted_at IS NULL AND source_expires_at <= now()
         AND NOT retention_hold AND NOT retention_hold_target AND retention_hold_sync_status = 'synced'
         AND source_delete_status IN ('pending', 'eligible', 'requested'))::int AS overdue_count,
       count(*) FILTER (WHERE source_deleted_at IS NULL AND source_delete_status IN ('eligible', 'requested')
         AND source_expires_at <= now())::int AS eligible_stuck_count,
       count(*) FILTER (WHERE source_delete_status = 'deleting'
         AND source_delete_claimed_at <= now() - interval '15 minutes')::int AS deleting_stuck_count,
       count(*) FILTER (WHERE source_delete_status = 'failed'
         AND source_delete_next_retry_at IS NOT NULL AND source_delete_next_retry_at <= now())::int AS failed_past_retry_count,
       count(*) FILTER (WHERE source_delete_status = 'failed'
         AND source_delete_attempts >= $1)::int AS final_failure_count,
       count(*) FILTER (WHERE retention_hold_sync_status <> 'synced'
         AND (retention_hold OR retention_hold_target))::int AS unsynced_hold_count,
       count(*) FILTER (WHERE retention_hold_sync_escalated_at IS NOT NULL)::int AS escalated_hold_count,
       count(*) FILTER (WHERE intermediate_deleted_at IS NULL AND intermediate_expires_at <= now()
         AND NOT retention_hold AND NOT retention_hold_target
         AND intermediate_delete_status IN ('pending', 'failed')
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.recording_id = recordings.id AND j.status IN ('queued', 'processing')))::int AS intermediate_overdue_count,
       count(*) FILTER (WHERE intermediate_expires_at IS NULL)::int AS intermediate_missing_expiry_count,
       count(*) FILTER (WHERE intermediate_delete_status = 'deleting'
         AND intermediate_delete_claimed_at <= now() - interval '15 minutes')::int AS intermediate_stuck_count,
       count(*) FILTER (WHERE intermediate_delete_status = 'failed'
         AND intermediate_delete_next_retry_at IS NOT NULL AND intermediate_delete_next_retry_at <= now())::int AS intermediate_failed_past_retry_count,
       count(*) FILTER (WHERE intermediate_delete_status = 'failed'
         AND intermediate_delete_attempts >= $1)::int AS intermediate_final_failure_count
     FROM recordings`,
    [RECORDING_DELETE_MAX_ATTEMPTS],
  )).rows[0]
  return {
    overdueCount: Number(row.overdue_count),
    eligibleStuckCount: Number(row.eligible_stuck_count),
    deletingStuckCount: Number(row.deleting_stuck_count),
    failedPastRetryCount: Number(row.failed_past_retry_count),
    finalFailureCount: Number(row.final_failure_count),
    unsyncedHoldCount: Number(row.unsynced_hold_count),
    escalatedHoldCount: Number(row.escalated_hold_count),
    intermediateOverdueCount: Number(row.intermediate_overdue_count),
    intermediateMissingExpiryCount: Number(row.intermediate_missing_expiry_count),
    intermediateStuckCount: Number(row.intermediate_stuck_count),
    intermediateFailedPastRetryCount: Number(row.intermediate_failed_past_retry_count),
    intermediateFinalFailureCount: Number(row.intermediate_final_failure_count),
  }
}

export async function listRetentionHoldVerificationCandidates(
  db: Db,
  limit = 100,
  afterId?: string,
): Promise<{ candidates: RetentionHoldVerificationCandidate[], hasMore: boolean }> {
  const rows = (await db.query(
    `SELECT id, object_path, retention_hold, source_generation
       FROM recordings
      WHERE source_deleted_at IS NULL AND source_generation IS NOT NULL
        AND retention_hold_sync_status = 'synced'
        AND ($2::uuid IS NULL OR id > $2::uuid)
      ORDER BY id
      LIMIT $1`,
    [limit + 1, afterId ?? null],
  )).rows
  const candidates = rows.slice(0, limit).map((row) => ({
    recordingId: row.id as string,
    objectPath: row.object_path as string,
    expectedHold: Boolean(row.retention_hold),
    generation: decimalString(row.source_generation),
  }))
  return { candidates, hasMore: rows.length > limit }
}
