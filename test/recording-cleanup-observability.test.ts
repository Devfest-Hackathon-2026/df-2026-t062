import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safeErrorCode, writeCleanupLog } from '../worker/recording-cleanup-observability.ts'

test('cleanup observability only accepts known error codes', () => {
  assert.equal(safeErrorCode('permission_denied'), 'permission_denied')
  assert.equal(safeErrorCode('free-form database error'), 'unknown')
  assert.equal(safeErrorCode(undefined), 'unknown')
})

test('cleanup observability sanitizes free-form error codes and fields', () => {
  const original = console.log
  const lines: string[] = []
  console.log = (line?: unknown) => lines.push(String(line))
  try {
    writeCleanupLog({
      event: 'recording.retention.delete',
      operation: 'delete',
      result: 'failed',
      error_code: 'raw database details with PII',
      ...( { secret: 'must not be logged' } as Record<string, unknown>),
    } as never)
  } finally {
    console.log = original
  }
  const log = JSON.parse(lines[0]) as Record<string, unknown>
  assert.equal(log.error_code, 'unknown')
  assert.equal('secret' in log, false)
})

test('cleanup observability log contains aggregate fields but no recording content', () => {
  const original = console.log
  const lines: string[] = []
  console.log = (line?: unknown) => lines.push(String(line))
  try {
    writeCleanupLog({
      event: 'recording.retention.cleanup',
      operation: 'delete',
      result: 'success',
      candidate_count: 2,
      success_count: 2,
      duration_ms: 100,
    })
  } finally {
    console.log = original
  }
  const log = JSON.parse(lines[0]) as Record<string, unknown>
  assert.equal(log.service, 'recording-cleanup')
  assert.equal(log.candidate_count, 2)
  assert.equal('object_path' in log, false)
  assert.equal('transcript' in log, false)
  assert.equal('client_id' in log, false)
})
