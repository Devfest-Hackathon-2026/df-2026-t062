import {
  claimRecordingDeletionCandidates,
  claimRetentionHoldSyncCandidate,
  completeRetentionHoldSync,
  failRetentionHoldSync,
  markRecordingSourceDeleteFailed,
  markRecordingSourceDeleted,
  type ClaimedDeletionCandidate,
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

const asDecimal = (value: string): DecimalString => value as DecimalString

function retryable(code: string) {
  return RETRYABLE_SOURCE_OBJECT_ERROR_CODES.has(code as never)
}

async function metadataFor(storage: SourceObjectControl, path: string): Promise<MetadataResult> {
  const result = await storage.getLiveObjectMetadata(path)
  return result
}

async function syncCandidate(deps: WorkerDeps, candidate: HoldSyncCandidate) {
  const db = await deps.db()
  const control = deps.storage().sourceObjects()
  const metadata = await metadataFor(control, candidate.objectPath)
  if (metadata.kind === 'not_found') {
    await failRetentionHoldSync(db, candidate, 'object_missing')
    return
  }
  if (metadata.kind === 'error') {
    await failRetentionHoldSync(db, candidate, metadata.code)
    return
  }
  if (candidate.generation && candidate.generation !== metadata.metadata.generation) {
    await failRetentionHoldSync(db, candidate, 'generation_mismatch')
    return
  }
  const generation = candidate.generation ?? metadata.metadata.generation
  const metageneration = candidate.metageneration ?? metadata.metadata.metageneration
  const result = await control.setTemporaryHold(candidate.objectPath, generation, metageneration, candidate.target)
  if (result.kind === 'updated') {
    await completeRetentionHoldSync(db, candidate, result.metadata)
    return
  }
  await failRetentionHoldSync(db, candidate, result.kind === 'not_found' ? 'object_missing' : result.code)
}

export async function synchronizeRetentionHold(deps: WorkerDeps, recordingId: string, operationVersion: string) {
  const db = await deps.db()
  const candidate = await claimRetentionHoldSyncCandidate(db, recordingId, asDecimal(operationVersion))
  if (candidate) await syncCandidate(deps, candidate)
}

export async function synchronizeRetentionHolds(deps: WorkerDeps, limit = 100) {
  const db = await deps.db()
  const candidates = await (await import('../db/recording-retention.ts')).claimRetentionHoldSyncCandidates(db, limit)
  for (const candidate of candidates) await syncCandidate(deps, candidate)
  return candidates.length
}

async function deleteCandidate(deps: WorkerDeps, candidate: ClaimedDeletionCandidate) {
  const db = await deps.db()
  const control = deps.storage().sourceObjects()
  const result = await control.deleteObjectGeneration(candidate.objectPath, candidate.generation)
  if (result.kind === 'deleted') {
    await markRecordingSourceDeleted(db, candidate)
    return
  }
  if (result.kind === 'not_found') {
    const live = await metadataFor(control, candidate.objectPath)
    if (live.kind === 'not_found') {
      await markRecordingSourceDeleted(db, candidate)
      return
    }
    await markRecordingSourceDeleteFailed(db, candidate, 'generation_mismatch', false)
    return
  }
  await markRecordingSourceDeleteFailed(db, candidate, result.code, retryable(result.code))
}

export async function deleteExpiredSourceRecordings(deps: WorkerDeps, limit = 100) {
  const db = await deps.db()
  const candidates = await claimRecordingDeletionCandidates(db, limit)
  for (const candidate of candidates) await deleteCandidate(deps, candidate)
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
  await runBatched((batchLimit) => backfillRecordingSourceMetadata(deps, batchLimit), limit, startedAt)
  const holds = await runBatched((batchLimit) => synchronizeRetentionHolds(deps, batchLimit), limit, startedAt)
  const uploads = await runBatched((batchLimit) => cancelStaleUploadSessions(deps, batchLimit), limit, startedAt)
  const deletions = await runBatched((batchLimit) => deleteExpiredSourceRecordings(deps, batchLimit), limit, startedAt)
  return { holds, uploads, deletions }
}
