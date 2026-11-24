import type { Usage } from './types.ts'
import type { Db } from '../db/pool.ts'

export type AiJobType = 'recording' | 'document_input' | 'form_import' | 'document_fill' | 'inspection'
export type AiJobPhase = 'started' | 'succeeded' | 'partial' | 'failed' | 'retry' | 'lease_expired'

export interface AiJobEvent {
  jobType: AiJobType
  phase: AiJobPhase
  jobId?: string
  attempt?: number
  durationMs?: number
  queueWaitMs?: number
  usage?: Usage | null
  errorCode?: unknown
  retryable?: boolean
  context?: { requestId?: string, correlationId?: string, traceId?: string }
  counts?: Record<string, number>
  eventName?: 'ai.job' | 'ai.queue'
}

const knownErrorCodes = new Set([
  'Error', 'LeaseLost', 'DocumentMissing', 'IntermediateRetentionExpired',
  'attempts_exhausted', 'processing_failed', 'document_missing', 'recording_not_found',
  'intermediate_retention_expired', 'reader_not_configured', 'writer_not_configured',
  'hash_mismatch', 'read_limit', 'no_topics', 'not_found', 'permission_denied',
  'invalid_argument', 'deadline_exceeded', 'resource_exhausted', 'unavailable',
])

const allowedCountKeys = new Set([
  'changes', 'kept', 'review', 'candidate_count', 'target_count', 'written_count', 'item_count', 'missing_count',
  'queue_queued_count', 'queue_processing_count', 'queue_oldest_queued_age_seconds',
  'queue_oldest_processing_age_seconds', 'queue_lease_expired_count', 'queue_requeued_count',
])

export function safeAiJobErrorCode(value: unknown): string {
  return typeof value === 'string' && knownErrorCodes.has(value) ? value : 'unknown'
}

const finiteNonNegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

export function writeAiJobEvent(event: AiJobEvent): void {
  const usage = event.usage
  const counts = Object.fromEntries(Object.entries(event.counts ?? {}).filter(([key, value]) => allowedCountKeys.has(key) && finiteNonNegative(value) !== undefined))
  const output: Record<string, unknown> = {
    severity: event.phase === 'failed' || event.phase === 'lease_expired' ? 'ERROR' : 'INFO',
    service: 'worker',
    event: event.eventName ?? 'ai.job',
    job_type: event.jobType,
    phase: event.phase,
    job_id: event.jobId,
    attempt: finiteNonNegative(event.attempt),
    duration_ms: finiteNonNegative(event.durationMs),
    queue_wait_ms: finiteNonNegative(event.queueWaitMs),
    calls: finiteNonNegative(usage?.calls),
    prompt_tokens: finiteNonNegative(usage?.promptTokens),
    cached_tokens: finiteNonNegative(usage?.cachedTokens),
    output_tokens: finiteNonNegative(usage?.outputTokens),
    thinking_tokens: finiteNonNegative(usage?.thinkingTokens),
    estimated_cost_yen: finiteNonNegative(usage?.yen),
    error_code: event.errorCode === undefined ? undefined : safeAiJobErrorCode(event.errorCode),
    retryable: event.retryable,
    ...counts,
    request_id: event.context?.requestId,
    correlation_id: event.context?.correlationId,
    trace_id: event.context?.traceId,
  }
  console.log(JSON.stringify(Object.fromEntries(Object.entries(output).filter(([, value]) => value !== undefined))))
}

export function usageFromSteps(value: unknown): Usage {
  const result: Usage = { calls: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, thinkingTokens: 0, yen: 0 }
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if (typeof record.calls === 'number' && typeof record.yen === 'number') {
      for (const key of ['calls', 'promptTokens', 'cachedTokens', 'outputTokens', 'thinkingTokens', 'yen'] as const) {
        const value = record[key]
        if (typeof value === 'number' && Number.isFinite(value)) result[key] += value
      }
      return
    }
    for (const child of Object.values(record)) visit(child)
  }
  visit(value)
  return result
}

const queueTables = {
  recording: 'jobs',
  document_input: 'document_inputs',
  form_import: 'form_imports',
  document_fill: 'document_fills',
  inspection: 'inspections',
} as const

export async function writeAiQueueSnapshot(db: Db, jobType: AiJobType, requeuedCount = 0): Promise<void> {
  try {
    const table = queueTables[jobType]
    const row = (await db.query(`
      SELECT
        count(*) FILTER (WHERE status = 'queued')::int AS queued_count,
        count(*) FILTER (WHERE status = 'processing')::int AS processing_count,
        coalesce(extract(epoch FROM (now() - min(created_at) FILTER (WHERE status = 'queued'))), 0)::int AS oldest_queued_age_seconds,
        coalesce(extract(epoch FROM (now() - min(updated_at) FILTER (WHERE status = 'processing'))), 0)::int AS oldest_processing_age_seconds,
        count(*) FILTER (WHERE status = 'processing' AND lease_until < now())::int AS lease_expired_count
      FROM ${table}`)).rows[0]
    writeAiJobEvent({
      eventName: 'ai.queue', jobType, phase: 'started', counts: {
        queue_queued_count: Number(row.queued_count) || 0,
        queue_processing_count: Number(row.processing_count) || 0,
        queue_oldest_queued_age_seconds: Number(row.oldest_queued_age_seconds) || 0,
        queue_oldest_processing_age_seconds: Number(row.oldest_processing_age_seconds) || 0,
        queue_lease_expired_count: Number(row.lease_expired_count) || 0,
        queue_requeued_count: requeuedCount,
      },
    })
  } catch (e) {
    console.log(JSON.stringify({ severity: 'WARNING', service: 'worker', event: 'ai.queue_observability_failed', job_type: jobType, error_code: safeAiJobErrorCode((e as Error).name) }))
  }
}
