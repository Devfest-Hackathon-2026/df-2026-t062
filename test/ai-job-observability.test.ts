import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safeAiJobErrorCode, usageFromSteps, writeAiJobEvent } from '../worker/ai-job-observability.ts'

test('AI監視イベントは許可された集計値だけを出力する', () => {
  const original = console.log
  const lines: string[] = []
  console.log = (line?: unknown) => lines.push(String(line))
  try {
    writeAiJobEvent({
      jobType: 'recording', phase: 'succeeded', jobId: 'job-1', attempt: 1,
      durationMs: 1200,
      usage: { calls: 2, promptTokens: 10, cachedTokens: 2, outputTokens: 3, thinkingTokens: 1, yen: 4 },
      counts: { changes: 2 },
      context: { requestId: 'request-1' },
    })
  } finally {
    console.log = original
  }
  const event = JSON.parse(lines[0]) as Record<string, unknown>
  assert.equal(event.event, 'ai.job')
  assert.equal(event.estimated_cost_yen, 4)
  assert.equal(event.changes, 2)
  assert.equal('transcript' in event, false)
  assert.equal('prompt' in event, false)
  assert.equal('output' in event, false)
})

test('AI監視イベントの集計キーは許可リストで制限する', () => {
  const original = console.log
  const lines: string[] = []
  console.log = (line?: unknown) => lines.push(String(line))
  try {
    writeAiJobEvent({ jobType: 'recording', phase: 'succeeded', counts: { changes: 1, transcript: '機微情報' as unknown as number } })
  } finally {
    console.log = original
  }
  const event = JSON.parse(lines[0]) as Record<string, unknown>
  assert.equal(event.changes, 1)
  assert.equal('transcript' in event, false)
})

test('AI監視イベントは自由形式のエラー内容をunknownへ変換する', () => {
  assert.equal(safeAiJobErrorCode('permission_denied'), 'permission_denied')
  assert.equal(safeAiJobErrorCode('patient name leaked'), 'unknown')
  assert.equal(safeAiJobErrorCode(undefined), 'unknown')
})

test('ジョブのstepsからusageを重複なく集計する', () => {
  assert.deepEqual(usageFromSteps({
    summarize: { usage: { calls: 1, promptTokens: 10, cachedTokens: 0, outputTokens: 2, thinkingTokens: 1, yen: 3 } },
    write: { usage: { calls: 2, promptTokens: 20, cachedTokens: 4, outputTokens: 5, thinkingTokens: 2, yen: 7 } },
    totalSeconds: 10,
  }), { calls: 3, promptTokens: 30, cachedTokens: 4, outputTokens: 7, thinkingTokens: 3, yen: 10 })
})
