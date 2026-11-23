// #152: どの書類からでも録音できる。端末に残した録音も、送るときに録音を始めた書類につなぐ。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { api } from '../src/lib/api.ts'
import { sendRecording } from '../src/components/recording/recordingUpload.ts'

test('録音を送るとき、録音を始めた書類（documentId）を API に渡す。書類のない古い録音は渡さない（主な書類につながる）', async (t) => {
  const calls: unknown[][] = []
  const start = api.startRecording
  const complete = api.completeRecording
  api.startRecording = (async (...args: unknown[]) => { calls.push(args); return { recordingId: 'r1', uploadUrl: null } }) as typeof api.startRecording
  api.completeRecording = (async () => ({ jobId: 'j1', status: 'queued' })) as typeof api.completeRecording
  t.after(() => { api.startRecording = start; api.completeRecording = complete })

  const blob = new Blob(['x'], { type: 'audio/webm' })
  await sendRecording({ id: 'dev-1', clientId: 'c1', documentId: 'doc-adm', blob, mime: 'audio/webm', startedAt: 0, durationMs: 1000 }, () => {})
  await sendRecording({ id: 'dev-2', clientId: 'c1', blob, mime: 'audio/webm', startedAt: 0, durationMs: 1000 }, () => {})
  assert.deepEqual(calls, [['c1', 'audio/webm', 'dev-1', undefined, 'doc-adm'], ['c1', 'audio/webm', 'dev-2', undefined, undefined]])
})

test('API の startRecording は documentId を本文に入れる', async (t) => {
  const bodies: unknown[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ recordingId: 'r1', uploadUrl: null }), { status: 201, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  await api.startRecording('c1', 'audio/webm', 'dev-1', undefined, 'doc-adm')
  assert.deepEqual(bodies, [{ mime: 'audio/webm', deviceRecordingId: 'dev-1', documentId: 'doc-adm' }])
})
