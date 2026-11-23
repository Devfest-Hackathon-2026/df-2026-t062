export const CLEANUP_EVENTS = {
  job: 'recording.retention.job',
  cleanup: 'recording.retention.cleanup',
  deletion: 'recording.retention.delete',
  overdue: 'recording.retention.overdue',
  holdMismatch: 'recording.retention.hold_mismatch',
} as const

export type CleanupResult = 'started' | 'success' | 'failed' | 'detected'

export interface CleanupSummaryLog {
  event: string
  operation: string
  result: CleanupResult
  duration_ms?: number
  metadata_count?: number
  hold_count?: number
  candidate_count?: number
  success_count?: number
  failure_count?: number
  retry_count?: number
  final_failure_count?: number
  overdue_count?: number
  hold_mismatch_count?: number
  hold_alert_count?: number
  hold_verification_error_count?: number
  hold_verification_truncated?: boolean
  stuck_count?: number
  hold_sync_failure_count?: number
  eligible_stuck_count?: number
  deleting_stuck_count?: number
  failed_past_retry_count?: number
  unsynced_hold_count?: number
  escalated_hold_count?: number
  missing_expiry_count?: number
  missing_generation_count?: number
  legacy_hold_sync_count?: number
  failed_deletion_count?: number
  stuck_deletion_count?: number
  stale_upload_count?: number
  failure_rate_percent?: number
  error_code?: string
  retryable?: boolean
  mismatch_type?: string
}

const ALLOWED_ERROR_CODES = new Set([
  'permission_denied', 'rate_limited', 'unavailable', 'precondition_failed',
  'invalid_request', 'generation_mismatch', 'object_held', 'object_missing',
  'upload_cancel_failed', 'database_error', 'unknown',
])
const ALLOWED_OPERATIONS = new Set(['readiness', 'metadata_sync', 'cleanup', 'delete', 'check', 'verify'])
const ALLOWED_MISMATCH_TYPES = new Set(['db_gcs_hold_state', 'gcs_hold_verification_failed'])

export function safeErrorCode(code: string | undefined): string {
  return code && ALLOWED_ERROR_CODES.has(code) ? code : 'unknown'
}

export function writeCleanupLog(payload: CleanupSummaryLog) {
  const sanitized = {
    event: Object.values(CLEANUP_EVENTS).includes(payload.event as typeof CLEANUP_EVENTS[keyof typeof CLEANUP_EVENTS]) ? payload.event : CLEANUP_EVENTS.job,
    operation: ALLOWED_OPERATIONS.has(payload.operation) ? payload.operation : 'cleanup',
    result: payload.result,
    ...(payload.duration_ms === undefined ? {} : { duration_ms: payload.duration_ms }),
    ...(payload.metadata_count === undefined ? {} : { metadata_count: payload.metadata_count }),
    ...(payload.hold_count === undefined ? {} : { hold_count: payload.hold_count }),
    ...(payload.candidate_count === undefined ? {} : { candidate_count: payload.candidate_count }),
    ...(payload.success_count === undefined ? {} : { success_count: payload.success_count }),
    ...(payload.failure_count === undefined ? {} : { failure_count: payload.failure_count }),
    ...(payload.retry_count === undefined ? {} : { retry_count: payload.retry_count }),
    ...(payload.final_failure_count === undefined ? {} : { final_failure_count: payload.final_failure_count }),
    ...(payload.overdue_count === undefined ? {} : { overdue_count: payload.overdue_count }),
    ...(payload.hold_mismatch_count === undefined ? {} : { hold_mismatch_count: payload.hold_mismatch_count }),
    ...(payload.hold_alert_count === undefined ? {} : { hold_alert_count: payload.hold_alert_count }),
    ...(payload.hold_verification_error_count === undefined ? {} : { hold_verification_error_count: payload.hold_verification_error_count }),
    ...(payload.hold_verification_truncated === undefined ? {} : { hold_verification_truncated: payload.hold_verification_truncated }),
    ...(payload.stuck_count === undefined ? {} : { stuck_count: payload.stuck_count }),
    ...(payload.eligible_stuck_count === undefined ? {} : { eligible_stuck_count: payload.eligible_stuck_count }),
    ...(payload.deleting_stuck_count === undefined ? {} : { deleting_stuck_count: payload.deleting_stuck_count }),
    ...(payload.failed_past_retry_count === undefined ? {} : { failed_past_retry_count: payload.failed_past_retry_count }),
    ...(payload.unsynced_hold_count === undefined ? {} : { unsynced_hold_count: payload.unsynced_hold_count }),
    ...(payload.escalated_hold_count === undefined ? {} : { escalated_hold_count: payload.escalated_hold_count }),
    ...(payload.missing_expiry_count === undefined ? {} : { missing_expiry_count: payload.missing_expiry_count }),
    ...(payload.missing_generation_count === undefined ? {} : { missing_generation_count: payload.missing_generation_count }),
    ...(payload.legacy_hold_sync_count === undefined ? {} : { legacy_hold_sync_count: payload.legacy_hold_sync_count }),
    ...(payload.failed_deletion_count === undefined ? {} : { failed_deletion_count: payload.failed_deletion_count }),
    ...(payload.stuck_deletion_count === undefined ? {} : { stuck_deletion_count: payload.stuck_deletion_count }),
    ...(payload.stale_upload_count === undefined ? {} : { stale_upload_count: payload.stale_upload_count }),
    ...(payload.failure_rate_percent === undefined ? {} : { failure_rate_percent: payload.failure_rate_percent }),
    ...(payload.error_code === undefined ? {} : { error_code: safeErrorCode(payload.error_code) }),
    ...(payload.retryable === undefined ? {} : { retryable: payload.retryable }),
    ...(payload.mismatch_type === undefined || !ALLOWED_MISMATCH_TYPES.has(payload.mismatch_type) ? {} : { mismatch_type: payload.mismatch_type }),
  }
  console.log(JSON.stringify({
    severity: sanitized.result === 'failed' ? 'ERROR' : 'INFO',
    service: 'recording-cleanup',
    ...sanitized,
  }))
}
