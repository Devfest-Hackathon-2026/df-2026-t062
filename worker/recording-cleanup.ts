import { closePool, getDb } from '../db/pool.ts'
import { defaultStorage } from '../api/storage.ts'
import { lifecycleReadiness } from '../db/recording-retention.ts'
import { runRecordingCleanup, synchronizeRecordingLifecycleMetadata } from './recording-cleanup-service.ts'
import { CLEANUP_EVENTS, writeCleanupLog } from './recording-cleanup-observability.ts'

const storage = defaultStorage()
const deps = { db: getDb, storage: () => storage, providers: async () => { throw new Error('cleanup does not use providers') } }

if (process.argv.includes('--synchronize-lifecycle-metadata')) {
  const startedAt = Date.now()
  let metadataCount = 0
  let holdCount = 0
  let failureCount = 0
  for (let batch = 0; batch < 10; batch++) {
    const result = await synchronizeRecordingLifecycleMetadata(deps)
    metadataCount += result.metadata
    holdCount += result.holds
    failureCount += result.failures
    if (result.metadata === 0 && result.holds === 0) break
  }
  const result = await lifecycleReadiness(await getDb())
  const readinessFailed = result.unsyncedHolds > 0 || result.escalatedHolds > 0 || result.missingExpiry > 0
    || result.missingGeneration > 0 || result.legacyHoldSync > 0 || result.failedDeletions > 0
    || result.stuckDeletions > 0 || result.staleUploads > 0 || failureCount > 0
  writeCleanupLog({
    event: CLEANUP_EVENTS.job,
    operation: 'metadata_sync',
    result: readinessFailed ? 'failed' : 'success',
    duration_ms: Date.now() - startedAt,
    metadata_count: metadataCount,
    hold_count: holdCount,
    failure_count: failureCount,
    unsynced_hold_count: result.unsyncedHolds,
    escalated_hold_count: result.escalatedHolds,
    missing_expiry_count: result.missingExpiry,
    missing_generation_count: result.missingGeneration,
    legacy_hold_sync_count: result.legacyHoldSync,
    failed_deletion_count: result.failedDeletions,
    stuck_deletion_count: result.stuckDeletions,
    stale_upload_count: result.staleUploads,
  })
  await closePool(await getDb())
  if (readinessFailed) process.exitCode = 1
} else if (process.argv.includes('--verify-lifecycle-readiness')) {
  const result = await lifecycleReadiness(await getDb())
  const readinessFailed = result.unsyncedHolds > 0 || result.escalatedHolds > 0 || result.missingExpiry > 0
    || result.missingGeneration > 0 || result.legacyHoldSync > 0 || result.failedDeletions > 0
    || result.stuckDeletions > 0 || result.staleUploads > 0
  writeCleanupLog({
    event: CLEANUP_EVENTS.job,
    operation: 'readiness',
    result: readinessFailed ? 'failed' : 'success',
    unsynced_hold_count: result.unsyncedHolds,
    escalated_hold_count: result.escalatedHolds,
    missing_expiry_count: result.missingExpiry,
    missing_generation_count: result.missingGeneration,
    legacy_hold_sync_count: result.legacyHoldSync,
    failed_deletion_count: result.failedDeletions,
    stuck_deletion_count: result.stuckDeletions,
    stale_upload_count: result.staleUploads,
  })
  await closePool(await getDb())
  if (readinessFailed) process.exitCode = 1
} else {
  const startedAt = Date.now()
  writeCleanupLog({ event: CLEANUP_EVENTS.job, operation: 'cleanup', result: 'started' })
  try {
    const result = await runRecordingCleanup(deps)
    const duration = Date.now() - startedAt
    const failureRate = result.deletions === 0 ? 0 : (result.metrics.deletionFailureCount / result.deletions) * 100
    writeCleanupLog({
      event: CLEANUP_EVENTS.cleanup,
      operation: 'delete',
      result: result.metrics.failureCount > 0 ? 'failed' : 'success',
      duration_ms: duration,
      candidate_count: result.deletions,
      success_count: result.metrics.deletionSuccessCount,
      failure_count: result.metrics.deletionFailureCount,
      retry_count: result.metrics.deletionRetryCount,
      final_failure_count: result.metrics.deletionFinalFailureCount,
      overdue_count: result.overdueCount,
      hold_mismatch_count: result.holdMismatchCount,
      hold_alert_count: result.holdMismatchCount + result.holdVerificationErrorCount,
      hold_verification_error_count: result.holdVerificationErrorCount,
      hold_verification_truncated: result.holdVerificationTruncated,
      stuck_count: result.eligibleStuckCount + result.deletingStuckCount + result.failedPastRetryCount,
      hold_sync_failure_count: result.unsyncedHoldCount + result.escalatedHoldCount,
      eligible_stuck_count: result.eligibleStuckCount,
      deleting_stuck_count: result.deletingStuckCount,
      failed_past_retry_count: result.failedPastRetryCount,
      unsynced_hold_count: result.unsyncedHoldCount,
      escalated_hold_count: result.escalatedHoldCount,
      failure_rate_percent: Number(failureRate.toFixed(2)),
    })
    if (result.metrics.deletionRetryCount > 0) writeCleanupLog({
      event: CLEANUP_EVENTS.deletion,
      operation: 'delete',
      result: 'failed',
      retryable: true,
      failure_count: result.metrics.deletionRetryCount,
      error_code: 'unknown',
    })
    if (result.metrics.deletionFinalFailureCount > 0) writeCleanupLog({
      event: CLEANUP_EVENTS.deletion,
      operation: 'delete',
      result: 'failed',
      retryable: false,
      failure_count: result.metrics.deletionFinalFailureCount,
      error_code: 'unknown',
    })
    if (result.overdueCount > 0) writeCleanupLog({ event: CLEANUP_EVENTS.overdue, operation: 'check', result: 'detected', overdue_count: result.overdueCount })
    if (result.holdMismatchCount + result.holdVerificationErrorCount > 0) writeCleanupLog({
      event: CLEANUP_EVENTS.holdMismatch,
      operation: 'verify',
      result: 'detected',
      hold_mismatch_count: result.holdMismatchCount,
      hold_alert_count: result.holdMismatchCount + result.holdVerificationErrorCount,
      hold_verification_error_count: result.holdVerificationErrorCount,
      mismatch_type: result.holdVerificationErrorCount > 0 ? 'gcs_hold_verification_failed' : 'db_gcs_hold_state',
    })
  } catch (error) {
    writeCleanupLog({ event: CLEANUP_EVENTS.job, operation: 'cleanup', result: 'failed', error_code: 'database_error' })
    throw error
  } finally {
    await closePool(await getDb())
  }
}
