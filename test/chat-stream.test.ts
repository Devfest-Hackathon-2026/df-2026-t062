// 書き方の相談の答え（NDJSON）を読む（src/lib/chatStream.ts）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readChatStream } from '../src/lib/chatStream.ts'
import { ChatError, chatError } from '../core/chat-error.ts'
import { api } from '../src/lib/api.ts'
import { restoreChatText } from '../src/diagram/chatEntry.ts'

const body = (chunks: string[]) => new ReadableStream<Uint8Array>({
  start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close() },
})

test('step を届いた順に知らせ、done で答えを返す。行や文字が途中で切れて届いても読める', async () => {
  const done = JSON.stringify({ type: 'done', reply: 'できました', steps: ['用紙を読みました', '録音を探しました「畑」（1 件）'], proposals: [] })
  const all = `${JSON.stringify({ type: 'step', text: '用紙を読みました' })}\n${JSON.stringify({ type: 'step', text: '録音を探しました「畑」（1 件）' })}\n${done}\n`
  const bytes = new TextEncoder().encode(all)
  // 3 バイトずつ（日本語の 1 文字の途中でも切れる）
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3))
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(x); c.close() } })
  const live: string[] = []
  const r = await readChatStream(stream, (s) => live.push(s))
  assert.deepEqual(live, ['用紙を読みました', '録音を探しました「畑」（1 件）'])
  assert.deepEqual(r, { reply: 'できました', steps: live, proposals: [] })
})

test('error が来たら、done が来ないまま終わったら、失敗にする', async () => {
  await assert.rejects(readChatStream(body([`${JSON.stringify({ type: 'step', text: 'a' })}\n{"type":"error"}\n`]), () => {}))
  await assert.rejects(readChatStream(body([`${JSON.stringify({ type: 'step', text: 'a' })}\n`]), () => {}))
})

test('provider errors become fixed reasons; unknown codes and raw messages never reach the user', async () => {
  for (const [status, code] of [[503, 'overloaded'], [429, 'rate_limited'], [504, 'timeout'], [403, 'access_denied'], [404, 'model_unavailable']] as const) {
    const safe = chatError({ status, message: 'secret-provider-detail' })
    assert.equal(safe.code, code)
    await assert.rejects(readChatStream(body([JSON.stringify({ type: 'error', code: safe.code, message: 'secret-provider-detail' }) + '\n']), () => {}), (error: unknown) => error instanceof ChatError && error.code === code && !error.message.includes('secret-provider-detail'))
  }
  await assert.rejects(readChatStream(body(['{"type":"error","code":"constructor","message":"secret"}\n']), () => {}), (error: unknown) => error instanceof ChatError && error.code === 'unknown')
  await assert.rejects(readChatStream(body([]), () => {}), (error: unknown) => error instanceof ChatError && error.code === 'interrupted')
})

test('selected diagram travels separately from question text in the actual chat request', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (_url, init) => {
      const sent = JSON.parse(String(init?.body))
      assert.equal(sent.diagramField, 'health.bodyMap')
      assert.equal(sent.messages[0].text, 'ここに追加して')
      return new Response(body(['{"type":"error","code":"overloaded"}\n']), { status: 200 })
    }
    await assert.rejects(api.chat('doc', [{ role: 'user', text: 'ここに追加して' }], () => {}, undefined, 'health.bodyMap'), (error: unknown) => error instanceof ChatError && error.code === 'overloaded')
  } finally { globalThis.fetch = original }
  assert.equal(restoreChatText('送れなかった文', ''), '送れなかった文')
  assert.equal(restoreChatText('送れなかった文', '次に書いた文'), '送れなかった文\n\n次に書いた文')
  assert.equal(restoreChatText('同じ文', '同じ文'), '同じ文')
})
