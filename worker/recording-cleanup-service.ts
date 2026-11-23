import {
  claimRecordingDeletionCandidates,
  claimIntermediateDeletionCandidates,
  claimRetentionHoldSyncCandidate,
  completeRetentionHoldSync,
  failRetentionHoldSync,
  markRecordingSourceDeleteFailed,
  markRecordingSourceDeleted,
  markIntermediateDataDeleted,
  markIntermediateDataDeleteFailed,
  RECORDING_DELETE_MAX_ATTEMPTS,
  type ClaimedDeletionCandidate,
  type ClaimedIntermediateDeletionCandidate,
  type HoldSyncCandidate,
} from '../db/recording-retention.ts'
import { listRecordingGenerationBackfillCandidates, storeRecordingSourceMetadata } from '../db/recording-retention.ts'
import {
  claimStaleUploadSessions,
  completeUploadCancellation,
  failUploadCancellation,
  preserveCompletedUpload,
} from '../db/recording-upload-cleanup.ts'
import { RETRYABLE_SOURCE_OBJECT_ERROR_CODES, type DecimalString, type MetadataResult, type SourceObjectControl } from '../storage/source-object-control.ts'
import type { WorkerDeps } from './jobs.ts'
import {
  getRecordingRetentionObservability,
  listRetentionHoldVerificationCandidates,
} from '../db/recording-retention.ts'

const asDecimal = (value: string): DecimalString => value as DecimalString

function retryable(code: string) {
  return RETRYABLE_SOURCE_OBJECT_ERROR_CODES.has(code as never)
}

export interface CleanupMetrics {
  successCount: number
  failureCount: number
  retryCount: number
  finalFailureCount: number
  deletionSuccessCount: number
  deletionFailureCount: number
  deletionRetryCount: number
  deletionFinalFailureCount: number
  intermediateDeletionSuccessCount: number
  intermediateDeletionFailureCount: number
  intermediateDeletionRetryCount: number
  intermediateDeletionFinalFailureCount: number
}

const emptyMetrics = (): CleanupMetrics => ({
  successCount: 0,
  failureCount: 0,
  retryCount: 0,
  finalFailureCount: 0,
  deletionSuccessCount: 0,
  deletionFailureCount: 0,
  deletionRetryCount: 0,
  deletionFinalFailureCount: 0,
  intermediateDeletionSuccessCount: 0,
  intermediateDeletionFailureCount: 0,
  intermediateDeletionRetryCount: 0,
  intermediateDeletionFinalFailureCount: 0,
})

async function metadataFor(storage: SourceObjectControl, path: string): Promise<MetadataResult> {
  const result = await storage.getLiveObjectMetadata(path)
  return result
}

async function syncCandidate(deps: WorkerDeps, candidate: HoldSyncCandidate, metrics?: CleanupMetrics) {
  const db = await deps.db()
  const control = deps.storage().sourceObjects()
  const metadata = await metadataFor(control, candidate.objectPath)
  if (metadata.kind === 'not_found') {
    await failRetentionHoldSync(db, candidate, 'object_missing')
    if (metrics) { metrics.failureCount++; metrics.retryCount++ }
    return
  }
  if (metadata.kind === 'error') {
    await failRetentionHoldSync(db, candidate, metadata.code)
    if (metrics) { metrics.failureCount++; metrics.retryCount++ }
    return
  }
  if (candidate.generation && candidate.generation !== metadata.metadata.generation) {
    await failRetentionHoldSync(db, candidate, 'generation_mismatch')
    if (metrics) { metrics.failureCount++; metrics.retryCount++ }
    return
  }
  const generation = candidate.generation ?? metadata.metadata.generation
  const metageneration = candidate.metageneration ?? metadata.metadata.metageneration
  const result = await control.setTemporaryHold(candidate.objectPath, generation, metageneration, candidate.target)
  if (result.kind === 'updated') {
    await completeRetentionHoldSync(db, candidate, result.metadata)
    if (metrics) metrics.successCount++
    return
  }
  await failRetentionHoldSync(db, candidate, result.kind === 'not_found' ? 'object_missing' : result.code)
  if (metrics) { metrics.failureCount++; metrics.retryCount++ }
}

export async function synchronizeRetentionHold(deps: WorkerDeps, recordingId: string, operationVersion: string) {
  const db = await deps.db()
  const candidate = await claimRetentionHoldSyncCandidate(db, recordingId, asDecimal(operationVersion))
  if (candidate) await syncCandidate(deps, candidate)
}

export async function synchronizeRetentionHolds(deps: WorkerDeps, limit = 100, metrics?: CleanupMetrics) {
  const db = await deps.db()
  const candidates = await (await import('../db/recording-retention.ts')).claimRetentionHoldSyncCandidates(db, limit)
  for (const candidate of candidates) await syncCandidate(deps, candidate, metrics)
  return candidates.length
}

async function deleteCandidate(deps: WorkerDeps, candidate: ClaimedDeletionCandidate, metrics?: CleanupMetrics) {
  const db = await deps.db()
  const control = deps.storage().sourceObjects()
  const result = await control.deleteObjectGeneration(candidate.objectPath, candidate.generation)
  if (result.kind === 'deleted') {
    await markRecordingSourceDeleted(db, candidate)
    if (metrics) { metrics.successCount++; metrics.deletionSuccessCount++ }
    return
  }
  if (result.kind === 'not_found') {
    const live = await metadataFor(control, candidate.objectPath)
    if (live.kind === 'not_found') {
      await markRecordingSourceDeleted(db, candidate)
      if (metrics) { metrics.successCount++; metrics.deletionSuccessCount++ }
      return
    }
    await markRecordingSourceDeleteFailed(db, candidate, 'generation_mismatch', false)
    if (metrics) {
      metrics.failureCount++
      metrics.finalFailureCount++
      metrics.deletionFailureCount++
      metrics.deletionFinalFailureCount++
    }
    return
  }
  await markRecordingSourceDeleteFailed(db, candidate, result.code, retryable(result.code))
  if (metrics) {
    metrics.failureCount++
    metrics.deletionFailureCount++
    if (retryable(result.code)) {
      metrics.retryCount++
      metrics.deletionRetryCount++
    } else {
      metrics.finalFailureCount++
      metrics.deletionFinalFailureCount++
    }
  }
}

export async function deleteExpiredSourceRecordings(deps: WorkerDeps, limit = 100, metrics?: CleanupMetrics) {
  const db = await deps.db()
  const candidates = await claimRecordingDeletionCandidates(db, limit)
  for (const candidate of candidates) await deleteCandidate(deps, candidate, metrics)
  return candidates.length
}

async function deleteIntermediateCandidate(
  deps: WorkerDeps,
  candidate: ClaimedIntermediateDeletionCandidate,
  metrics?: CleanupMetrics,
) {
  const db = await deps.db()
  try {
    const result = await markIntermediateDataDeleted(db, candidate)
    if (result && metrics) metrics.intermediateDeletionSuccessCount++
  } catch {
    const retryableFailure = candidate.attempts < RECORDING_DELETE_MAX_ATTEMPTS
    await markIntermediateDataDeleteFailed(db, candidate, 'database_error', retryableFailure)
    if (metrics) {
      metrics.failureCount++
      metrics.intermediateDeletionFailureCount++
      if (retryableFailure) metrics.intermediateDeletionRetryCount++
      else metrics.intermediateDeletionFinalFailureCount++
    }
  }
}

export async function deleteExpiredIntermediateRecordings(deps: WorkerDeps, limit = 100, metrics?: CleanupMetrics) {
  const db = await deps.db()
  const candidates = await claimIntermediateDeletionCandidates(db, limit)
  for (const candidate of candidates) await deleteIntermediateCandidate(deps, candidate, metrics)
  return candidates.length
}

export async function backfillRecordingSourceMetadata(deps: WorkerDeps, limit = 100) {
  const db = await deps.db()
  const control = deps.storage().sourceObjects()
  const candidates = await listRecordingGenerationBackfillCandidates(db, limit)
  let updated = 0
  for (const candidate of candidates) {
    const result = await control.getLiveObjectMetadata(candidate.objectPath)
    if (result.kind !== 'found') continue
    if (await storeRecordingSourceMetadata(db, candidate.recordingId, result.metadata)) updated++
  }
  return updated
}

export async function synchronizeRecordingLifecycleMetadata(deps: WorkerDeps, limit = 100) {
  const metrics = emptyMetrics()
  const metadata = await backfillRecordingSourceMetadata(deps, limit)
  const holds = await synchronizeRetentionHolds(deps, limit, metrics)
  return { metadata, holds, failures: metrics.failureCount }
}

export async function cancelStaleUploadSessions(deps: WorkerDeps, limit = 100) {
  const db = await deps.db()
  const candidates = await claimStaleUploadSessions(db, limit)
  const control = deps.storage().sourceObjects()
  for (const candidate of candidates) {
    const live = await metadataFor(control, candidate.objectPath)
    if (live.kind === 'found') {
      await preserveCompletedUpload(db, candidate, live.metadata)
      continue
    }
    if (live.kind === 'error') {
      await failUploadCancellation(db, candidate, live.code)
      continue
    }
    const result = await control.cancelUploadSession(candidate.uploadSessionUrl)
    if (result.kind === 'cancelled' || result.kind === 'inactive') {
      const after = await metadataFor(control, candidate.objectPath)
      if (after.kind === 'found') await preserveCompletedUpload(db, candidate, after.metadata)
      else await completeUploadCancellation(db, candidate)
    } else await failUploadCancellation(db, candidate, result.code)
  }
  return candidates.length
}

export interface CleanupSummary {
  holds: number
  uploads: number
  deletions: number
  intermediateDeletions: number
  metrics: CleanupMetrics
  overdueCount: number
  holdMismatchCount: number
  holdVerificationErrorCount: number
  holdVerificationTruncated: boolean
  eligibleStuckCount: number
  deletingStuckCount: number
  failedPastRetryCount: number
  unsyncedHoldCount: number
  escalatedHoldCount: number
  intermediateOverdueCount: number
  intermediateMissingExpiryCount: number
  intermediateStuckCount: number
  intermediateFailedPastRetryCount: number
  intermediateFinalFailureCount: number
}

const MAX_BATCHES = 10
const MAX_RUNTIME_MS = 720_000

async function runBatched(
  processBatch: (limit: number) => Promise<number>,
  limit: number,
  startedAt = Date.now(),
) {
  let total = 0
  for (let batch = 0; batch < MAX_BATCHES && Date.now() - startedAt < MAX_RUNTIME_MS; batch++) {
    const processed = await processBatch(limit)
    total += processed
    if (processed < limit) break
  }
  return total
}

export async function runRecordingCleanup(deps: WorkerDeps, limit = 100): Promise<CleanupSummary> {
  const startedAt = Date.now()
  const metrics = emptyMetrics()
  await runBatched((batchLimit) => backfillRecordingSourceMetadata(deps, batchLimit), limit, startedAt)
  const holds = await runBatched((batchLimit) => synchronizeRetentionHolds(deps, batchLimit, metrics), limit, startedAt)
  const uploads = await runBatched((batchLimit) => cancelStaleUploadSessions(deps, batchLimit), limit, startedAt)
  const intermediateDeletions = await runBatched((batchLimit) => deleteExpiredIntermediateRecordings(deps, batchLimit, metrics), limit, startedAt)
  const deletions = await runBatched((batchLimit) => deleteExpiredSourceRecordings(deps, batchLimit, metrics), limit, startedAt)
  const dbSummary = await getRecordingRetentionObservability(await deps.db())
  let holdMismatchCount = 0
  let holdVerificationErrorCount = 0
  let afterId: string | undefined
  let hasMore = true
  let verificationPages = 0
  const maxVerificationPages = 10
  while (hasMore && verificationPages < maxVerificationPages && Date.now() - startedAt < MAX_RUNTIME_MS) {
    const page = await listRetentionHoldVerificationCandidates(await deps.db(), limit, afterId)
    verificationPages++
    for (const candidate of page.candidates) {
      const metadata = await deps.storage().sourceObjects().getLiveObjectMetadata(candidate.objectPath)
      if (metadata.kind === 'found') {
        if (metadata.metadata.temporaryHold !== candidate.expectedHold) holdMismatchCount++
      } else holdVerificationErrorCount++
      afterId = candidate.recordingId
    }
    hasMore = page.hasMore
    if (!page.candidates.length) break
  }
  return {
    holds,
    uploads,
    deletions,
    intermediateDeletions,
    metrics,
    overdueCount: dbSummary.overdueCount,
    holdMismatchCount,
    holdVerificationErrorCount,
    holdVerificationTruncated: hasMore,
    eligibleStuckCount: dbSummary.eligibleStuckCount,
    deletingStuckCount: dbSummary.deletingStuckCount,
    failedPastRetryCount: dbSummary.failedPastRetryCount,
    unsyncedHoldCount: dbSummary.unsyncedHoldCount,
    escalatedHoldCount: dbSummary.escalatedHoldCount,
    intermediateOverdueCount: dbSummary.intermediateOverdueCount,
    intermediateMissingExpiryCount: dbSummary.intermediateMissingExpiryCount,
    intermediateStuckCount: dbSummary.intermediateStuckCount,
    intermediateFailedPastRetryCount: dbSummary.intermediateFailedPastRetryCount,
    intermediateFinalFailureCount: dbSummary.intermediateFinalFailureCount,
  }
}
