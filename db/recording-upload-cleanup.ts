import { randomUUID } from 'node:crypto'
import type { Db } from './pool.ts'
import { decimalString, type DecimalString, type SourceObjectErrorCode } from '../storage/source-object-control.ts'

export const UPLOAD_ABANDON_AFTER_HOURS = 24
export const UPLOAD_CANCEL_MAX_ATTEMPTS = 6
const UPLOAD_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const

export interface UploadCancelCandidate {
  recordingId: string
  objectPath: string
  uploadSessionUrl: string
  claimToken: string
  attempts: number
}

export async function adoptLegacyUploadSessions(db: Db, limit = 100) {
  const result = await db.query(
    `UPDATE recordings SET upload_started_at = now()
      WHERE id IN (
        SELECT id FROM recordings
         WHERE status = 'uploading' AND upload_url IS NOT NULL AND upload_started_at IS NULL
         ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
      ) RETURNING id`,
    [limit],
  )
  return result.rows.map((row) => row.id as string)
}

export async function claimStaleUploadSessions(db: Db, limit = 100): Promise<UploadCancelCandidate[]> {
  await adoptLegacyUploadSessions(db, limit)
  const token = randomUUID()
  const rows = (await db.query(
    `WITH candidates AS (
       SELECT id FROM recordings
        WHERE upload_url IS NOT NULL
          AND (
            (status = 'uploading' AND upload_started_at <= now() - interval '24 hours'
              AND (upload_cancel_next_retry_at IS NULL OR upload_cancel_next_retry_at <= now()))
            OR (status = 'abandoning'
              AND upload_cancel_claimed_at <= now() - interval '15 minutes'
              AND (upload_cancel_next_retry_at IS NULL OR upload_cancel_next_retry_at <= now()))
          )
        ORDER BY upload_started_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE recordings r
        SET status = 'abandoning', upload_cancel_claim_token = $2, upload_cancel_claimed_at = now(),
            upload_cancel_last_attempt_at = now(), upload_cancel_attempts = upload_cancel_attempts + 1,
            upload_cancel_next_retry_at = NULL, upload_cancel_last_error_code = NULL
       FROM candidates c WHERE r.id = c.id
     RETURNING r.id, r.object_path, r.upload_url, r.upload_cancel_attempts`,
    [limit, token],
  )).rows
  return rows.map((row) => ({
    recordingId: row.id, objectPath: row.object_path, uploadSessionUrl: row.upload_url,
    claimToken: token, attempts: row.upload_cancel_attempts,
  }))
}

export async function preserveCompletedUpload(
  db: Db,
  candidate: UploadCancelCandidate,
  metadata: { generation: DecimalString, metageneration: DecimalString },
) {
  const result = await db.query(
    `UPDATE recordings
        SET status = 'uploading', upload_url = NULL, source_generation = $3, source_metageneration = $4,
            upload_cancel_claim_token = NULL, upload_cancel_claimed_at = NULL,
            upload_cancel_next_retry_at = NULL, upload_cancel_last_error_code = NULL
      WHERE id = $1 AND status = 'abandoning' AND upload_cancel_claim_token = $2 RETURNING id`,
    [candidate.recordingId, candidate.claimToken, metadata.generation, metadata.metageneration],
  )
  return result.rowCount === 1
}

export async function completeUploadCancellation(db: Db, candidate: UploadCancelCandidate) {
  const result = await db.query(
    `UPDATE recordings
        SET status = 'failed', upload_url = NULL, upload_cancel_claim_token = NULL,
            upload_cancel_claimed_at = NULL, upload_cancel_next_retry_at = NULL,
            upload_cancel_last_error_code = NULL
      WHERE id = $1 AND status = 'abandoning' AND upload_cancel_claim_token = $2 RETURNING id`,
    [candidate.recordingId, candidate.claimToken],
  )
  return result.rowCount === 1
}

export async function failUploadCancellation(
  db: Db,
  candidate: UploadCancelCandidate,
  errorCode: Exclude<SourceObjectErrorCode, 'precondition_failed'>,
) {
  const delay = candidate.attempts >= UPLOAD_CANCEL_MAX_ATTEMPTS
    ? 24 * 60 * 60_000
    : UPLOAD_RETRY_DELAYS_MS[Math.min(candidate.attempts - 1, UPLOAD_RETRY_DELAYS_MS.length - 1)] ?? 6 * 60 * 60_000
  const result = await db.query(
    `UPDATE recordings
        SET status = 'abandoning', upload_cancel_claim_token = NULL, upload_cancel_claimed_at = NULL,
            upload_cancel_next_retry_at = $4, upload_cancel_last_error_code = $3,
            upload_cancel_escalated_at = CASE WHEN upload_cancel_attempts >= $5 THEN coalesce(upload_cancel_escalated_at, now()) ELSE upload_cancel_escalated_at END
      WHERE id = $1 AND status = 'abandoning' AND upload_cancel_claim_token = $2 RETURNING id`,
    [candidate.recordingId, candidate.claimToken, errorCode, new Date(Date.now() + delay), UPLOAD_CANCEL_MAX_ATTEMPTS],
  )
  return result.rowCount === 1
}

export async function getUploadCleanupState(db: Db, recordingId: string) {
  const row = (await db.query(
    `SELECT status, upload_started_at, upload_completed_at, upload_cancel_attempts,
            upload_cancel_next_retry_at, upload_cancel_last_error_code, upload_cancel_escalated_at,
            source_generation, source_metageneration
       FROM recordings WHERE id = $1`,
    [recordingId],
  )).rows[0]
  if (!row) return null
  return {
    status: row.status as string,
    uploadStartedAt: row.upload_started_at ? new Date(row.upload_started_at).toISOString() : null,
    uploadCompletedAt: row.upload_completed_at ? new Date(row.upload_completed_at).toISOString() : null,
    attempts: Number(row.upload_cancel_attempts),
    nextRetryAt: row.upload_cancel_next_retry_at ? new Date(row.upload_cancel_next_retry_at).toISOString() : null,
    lastErrorCode: row.upload_cancel_last_error_code as string | null,
    escalatedAt: row.upload_cancel_escalated_at ? new Date(row.upload_cancel_escalated_at).toISOString() : null,
    generation: row.source_generation === null ? null : decimalString(row.source_generation),
    metageneration: row.source_metageneration === null ? null : decimalString(row.source_metageneration),
  }
}
