import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GoogleGenAI, GenerateContentParameters } from '@google/genai'
import { geminiChatModel } from '../api/gemini-chat.ts'
const request = { system: 'test-system', contents: [{ role: 'user' as const, parts: [{ text: 'synthetic-only' }] }], tools: [] }
const client = (generateContent: (params: GenerateContentParameters) => Promise<unknown>) => ({ models: { generateContent } }) as unknown as Pick<GoogleGenAI, 'models'>

test('Gemini carries the deadline and disables hidden SDK retries; authentication errors are not retried', async () => {
  let calls = 0
  const signal = AbortSignal.timeout(10000)
  const model = geminiChatModel({}, { client: client(async (params) => {
    calls++
    assert.equal(params.config?.abortSignal, signal)
    assert.equal(params.config?.httpOptions?.retryOptions?.attempts, 1)
    assert.equal(params.config?.httpOptions?.timeout, 60000)
    throw Object.assign(new Error('synthetic authentication failure'), { status: 403 })
  }) })
  await assert.rejects(model({ ...request, signal }))
  assert.equal(calls, 1)
})

test('a temporary Gemini failure gets one bounded retry and returns only real model parts', async () => {
  let calls = 0
  const model = geminiChatModel({}, { client: client(async () => {
    if (++calls === 1) throw Object.assign(new Error('synthetic temporary failure'), { status: 503 })
    return { candidates: [{ content: { parts: [{ text: '実モデル部分の代わりのテスト応答' }] } }] }
  }) })
  assert.deepEqual(await model(request), [{ text: '実モデル部分の代わりのテスト応答' }])
  assert.equal(calls, 2)
})

test('expired deadline prevents model requests, including retries', async () => {
  let calls = 0
  const signal = AbortSignal.abort(new DOMException('deadline', 'TimeoutError'))
  const model = geminiChatModel({}, { client: client(async () => { calls++; return {} }) })
  await assert.rejects(model({ ...request, signal }), { name: 'TimeoutError' })
  assert.equal(calls, 0)
})
