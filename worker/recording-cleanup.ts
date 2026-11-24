import { closePool, getDb } from '../db/pool.ts'
import { defaultStorage } from '../api/storage.ts'
import { lifecycleReadiness } from '../db/recording-retention.ts'
import {
  drainExpiredIntermediateRecordings,
  runRecordingCleanup,
  synchronizeRecordingLifecycleMetadata,
} from './recording-cleanup-service.ts'
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
  const metadataSyncFailed = result.unsyncedHolds > 0 || result.escalatedHolds > 0 || result.missingExpiry > 0
    || result.missingPurgeExpectation > 0 || result.missingGeneration > 0 || result.legacyHoldSync > 0 || failureCount > 0
  writeCleanupLog({
    event: CLEANUP_EVENTS.job,
    operation: 'metadata_sync',
    result: metadataSyncFailed ? 'failed' : 'success',
    duration_ms: Date.now() - startedAt,
    metadata_count: metadataCount,
    hold_count: holdCount,
    failure_count: failureCount,
    unsynced_hold_count: result.unsyncedHolds,
    escalated_hold_count: result.escalatedHolds,
    missing_expiry_count: result.missingExpiry,
    missing_purge_expectation_count: result.missingPurgeExpectation,
    missing_generation_count: result.missingGeneration,
    legacy_hold_sync_count: result.legacyHoldSync,
    failed_deletion_count: result.failedDeletions,
    stuck_deletion_count: result.stuckDeletions,
    stale_upload_count: result.staleUploads,
    expired_active_hold_count: result.expiredActiveHolds,
    intermediate_missing_expiry_count: result.intermediateMissingExpiry,
    intermediate_failure_count: result.intermediateFailedDeletions,
    intermediate_stuck_count: result.intermediateStuckDeletions,
    intermediate_deleted_state_mismatch_count: result.intermediateDeletedStateMismatch,
    intermediate_failed_past_retry_count: result.intermediateFailedPastRetry,
  })
  await closePool(await getDb())
  if (metadataSyncFailed) process.exitCode = 1
} else if (process.argv.includes('--cleanup-expired-intermediate-data')) {
  const startedAt = Date.now()
  writeCleanupLog({ event: CLEANUP_EVENTS.job, operation: 'cleanup', result: 'started' })
  try {
    const result = await drainExpiredIntermediateRecordings(deps)
    const failureCount = result.metrics.intermediateDeletionFailureCount
    writeCleanupLog({
      event: CLEANUP_EVENTS.cleanup,
      operation: 'delete',
      result: failureCount > 0 ? 'failed' : 'success',
      duration_ms: Date.now() - startedAt,
      candidate_count: result.deletions,
      success_count: result.metrics.intermediateDeletionSuccessCount,
      failure_count: failureCount,
      retry_count: result.metrics.intermediateDeletionRetryCount,
      final_failure_count: result.metrics.intermediateDeletionFinalFailureCount,
      intermediate_candidate_count: result.deletions,
      intermediate_success_count: result.metrics.intermediateDeletionSuccessCount,
      intermediate_failure_count: failureCount,
      intermediate_retry_count: result.metrics.intermediateDeletionRetryCount,
      intermediate_final_failure_count: result.metrics.intermediateDeletionFinalFailureCount,
    })
    if (failureCount > 0) process.exitCode = 1
  } catch (error) {
    writeCleanupLog({ event: CLEANUP_EVENTS.job, operation: 'cleanup', result: 'failed', error_code: 'database_error' })
    throw error
  } finally {
    await closePool(await getDb())
  }
} else if (process.argv.includes('--verify-lifecycle-readiness')) {
  const result = await lifecycleReadiness(await getDb())
  const readinessFailed = result.unsyncedHolds > 0 || result.escalatedHolds > 0 || result.missingExpiry > 0
    || result.missingPurgeExpectation > 0 || result.missingGeneration > 0 || result.legacyHoldSync > 0 || result.failedDeletions > 0
    || result.stuckDeletions > 0 || result.staleUploads > 0
    || result.expiredActiveHolds > 0
    || result.intermediateMissingExpiry > 0 || result.intermediateFailedDeletions > 0
    || result.intermediateStuckDeletions > 0 || result.intermediateDeletedStateMismatch > 0 || result.intermediateFailedPastRetry > 0
  writeCleanupLog({
    event: CLEANUP_EVENTS.job,
    operation: 'readiness',
    result: readinessFailed ? 'failed' : 'success',
    unsynced_hold_count: result.unsyncedHolds,
    escalated_hold_count: result.escalatedHolds,
    missing_expiry_count: result.missingExpiry,
    missing_purge_expectation_count: result.missingPurgeExpectation,
    missing_generation_count: result.missingGeneration,
    legacy_hold_sync_count: result.legacyHoldSync,
    failed_deletion_count: result.failedDeletions,
    stuck_deletion_count: result.stuckDeletions,
    stale_upload_count: result.staleUploads,
    expired_active_hold_count: result.expiredActiveHolds,
    intermediate_missing_expiry_count: result.intermediateMissingExpiry,
    intermediate_failure_count: result.intermediateFailedDeletions,
    intermediate_stuck_count: result.intermediateStuckDeletions,
    intermediate_deleted_state_mismatch_count: result.intermediateDeletedStateMismatch,
    intermediate_failed_past_retry_count: result.intermediateFailedPastRetry,
  })
  await closePool(await getDb())
  if (readinessFailed) process.exitCode = 1
} else {
  const startedAt = Date.now()
  writeCleanupLog({ event: CLEANUP_EVENTS.job, operation: 'cleanup', result: 'started' })
  try {
    const result = await runRecordingCleanup(deps)
    const duration = Date.now() - startedAt
    const totalCandidates = result.deletions + result.intermediateDeletions
    const totalSuccesses = result.metrics.deletionSuccessCount + result.metrics.intermediateDeletionSuccessCount
    const totalFailures = result.metrics.deletionFailureCount + result.metrics.intermediateDeletionFailureCount
    const totalRetries = result.metrics.deletionRetryCount + result.metrics.intermediateDeletionRetryCount
    const totalFinalFailures = result.metrics.deletionFinalFailureCount + result.metrics.intermediateDeletionFinalFailureCount
    const failureRate = totalCandidates === 0 ? 0 : (totalFailures / totalCandidates) * 100
    writeCleanupLog({
      event: CLEANUP_EVENTS.cleanup,
      operation: 'delete',
      result: result.metrics.failureCount > 0 ? 'failed' : 'success',
      duration_ms: duration,
      candidate_count: totalCandidates,
      success_count: totalSuccesses,
      failure_count: totalFailures,
      retry_count: totalRetries,
      final_failure_count: totalFinalFailures,
      overdue_count: result.overdueCount,
      hold_mismatch_count: result.holdMismatchCount,
      hold_alert_count: result.holdMismatchCount + result.holdVerificationErrorCount,
      hold_verification_error_count: result.holdVerificationErrorCount,
      hold_verification_truncated: result.holdVerificationTruncated,
      stuck_count: result.eligibleStuckCount + result.deletingStuckCount + result.failedPastRetryCount
        + result.intermediateOverdueCount + result.intermediateStuckCount + result.intermediateFailedPastRetryCount,
      hold_sync_failure_count: result.unsyncedHoldCount + result.escalatedHoldCount,
      eligible_stuck_count: result.eligibleStuckCount,
      deleting_stuck_count: result.deletingStuckCount,
      failed_past_retry_count: result.failedPastRetryCount,
      unsynced_hold_count: result.unsyncedHoldCount,
      escalated_hold_count: result.escalatedHoldCount,
      failure_rate_percent: Number(failureRate.toFixed(2)),
      intermediate_candidate_count: result.intermediateDeletions,
      intermediate_success_count: result.metrics.intermediateDeletionSuccessCount,
      intermediate_failure_count: result.metrics.intermediateDeletionFailureCount,
      intermediate_retry_count: result.metrics.intermediateDeletionRetryCount,
      intermediate_final_failure_count: result.metrics.intermediateDeletionFinalFailureCount,
      intermediate_overdue_count: result.intermediateOverdueCount,
      intermediate_missing_expiry_count: result.intermediateMissingExpiryCount,
      intermediate_stuck_count: result.intermediateStuckCount,
      intermediate_failed_past_retry_count: result.intermediateFailedPastRetryCount,
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
