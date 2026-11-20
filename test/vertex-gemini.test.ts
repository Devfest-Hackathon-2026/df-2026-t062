import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZERO_USAGE, type Person } from '../worker/types.ts'
import { mapLimit } from '../worker/vertex/common.ts'
import { geminiFactory, type AskMeta, type Llm } from '../worker/vertex/gemini.ts'
import { speakerAssigner } from '../worker/vertex/speakers.ts'

const people: Person[] = [{ label: '甲斐', role: '本人', relation: '利用者' }]

type Handler = (prompt: string, schema: any, meta: AskMeta) => unknown
const fakeLlm = (h: Handler, log: AskMeta[] = []) => (): Llm => ({
  ask: async (p, s, m) => { log.push(m); return h(p as string, s, m) },
  usage: () => ({ ...ZERO_USAGE, calls: log.length }),
})

test('mapLimit は同時に動かす数を絞り、順番どおりに返す', async () => {
  let running = 0
  let peak = 0
  const r = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => { running++; peak = Math.max(peak, running); await new Promise((ok) => setTimeout(ok, 5)); running--; return x * 2 })
  assert.deepEqual(r, [2, 4, 6, 8, 10, 12])
  assert.equal(peak, 2)
})

test('Gemini: 失敗したらやり直し、schema を断られたら schema なしで聞き直す。使った量と円を数える（キャッシュに当たった分は安い単価）', async () => {
  const calls: { schema: unknown | null, thinkingLevel?: string }[] = []
  const client = {
    async generate({ schema, thinkingLevel }: { schema: unknown | null, thinkingLevel?: string }) {
      calls.push({ schema, thinkingLevel })
      if (calls.length === 1) throw Object.assign(new Error('400 INVALID_ARGUMENT: bad schema'), { status: 400 })
      if (calls.length === 2) return { text: 'not json', prompt: 10, output: 1, thinking: 0, cached: 0 }
      return { text: '{"ok":true}', prompt: 1_000_000, output: 1_000_000, thinking: 0, cached: 600_000 }
    },
  }
  const llm = geminiFactory({ GEMINI_YEN_IN: '50', GEMINI_YEN_OUT: '400', GEMINI_YEN_CACHED: '5' }, { client, sleep: async () => {} })()
  const out = await llm.ask('p', { type: 'object' }, { step: 't' })
  assert.deepEqual(out, { ok: true })
  assert.deepEqual(calls.map((c) => c.schema), [{ type: 'object' }, null, null])
  // 思考の深さは、指定がなければ LOW
  assert.deepEqual(calls.map((c) => c.thinkingLevel), ['LOW', 'LOW', 'LOW'])
  const u = llm.usage()
  assert.equal(u.calls, 2)
  assert.equal(u.promptTokens, 1_000_010)
  assert.equal(u.cachedTokens, 600_000)
  // キャッシュに当たらなかった入力 400,010 は 50 円、当たった 600,000 は 5 円、出力と思考は 400 円（いずれも 100 万トークンあたり）
  assert.equal(u.yen, (400_010 * 50 + 600_000 * 5 + 1_000_001 * 400) / 1e6)
})

test('Gemini: 400（INVALID_ARGUMENT）は文面に schema がなくても、schema なしで聞き直す', async () => {
  const schemas: (unknown | null)[] = []
  const client = {
    async generate({ schema }: { schema: unknown | null }) {
      schemas.push(schema)
      if (schema) throw Object.assign(new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}'), { status: 400 })
      return { text: '{"ok":true}', prompt: 1, output: 1, thinking: 0, cached: 0 }
    },
  }
  const out = await geminiFactory({}, { client, sleep: async () => {} })().ask('p', { type: 'object' }, { step: 't' })
  assert.deepEqual(out, { ok: true })
  assert.deepEqual(schemas, [{ type: 'object' }, null])
})

test('Gemini: 思考の深さは GEMINI_THINKING_LEVEL で変えられ、DEFAULT ならモデルの既定に任せる。キャッシュの単価の既定は入力の 1 割', async () => {
  const levels: (string | undefined)[] = []
  const client = {
    async generate({ thinkingLevel }: { thinkingLevel?: string }) {
      levels.push(thinkingLevel)
      return { text: '{}', prompt: 1_000_000, output: 0, thinking: 0, cached: 1_000_000 }
    },
  }
  await geminiFactory({ GEMINI_THINKING_LEVEL: 'medium' }, { client })().ask('p', null, { step: 't' })
  await geminiFactory({ GEMINI_THINKING_LEVEL: 'DEFAULT' }, { client })().ask('p', null, { step: 't' })
  assert.deepEqual(levels, ['MEDIUM', undefined])
  const llm = geminiFactory({ GEMINI_YEN_IN: '100' }, { client })()
  await llm.ask('p', null, { step: 't' })
  assert.equal(llm.usage().yen, 10)
})

test('話した人: 知っている人はそのまま、新しい人は役割つきで返し、決められない記号は null', async () => {
  const handler: Handler = () => ({
    speakers: [
      { speaker: 'speaker_1', person: '甲斐', role: null, relation: null },
      { speaker: 'speaker_2', person: '長男の妻', role: '家族', relation: '長男の妻' },
      { speaker: 'speaker_3', person: null, role: null, relation: null },
      { speaker: 'speaker_9', person: '誰か', role: '家族', relation: null },   // 発言にない記号は無視
    ],
  })
  const u = (speaker: string) => ({ id: speaker, startMs: 0, endMs: 1, speaker, text: 'はい' })
  const r = await speakerAssigner(fakeLlm(handler)).assign({ utterances: [u('speaker_1'), u('speaker_2'), u('speaker_3')], people })
  assert.deepEqual(r.map, { speaker_1: '甲斐', speaker_2: '長男の妻', speaker_3: null })
  assert.deepEqual(r.newPeople, [{ label: '長男の妻', role: '家族', relation: '長男の妻' }])
})

test('Gemini: 認証・通信が応答しなくても時間切れで中断し、再試行回数を守る', async () => {
  const signals: AbortSignal[] = []
  const client = { generate({ signal }: { signal: AbortSignal }) {
    signals.push(signal)
    // AbortSignalを処理しない認証待ちでも、呼出側を止めない。
    return new Promise<never>(() => {})
  } }
  const llm = geminiFactory({}, { client, timeoutMs: 10, retries: 1, sleep: async () => {} })()
  await assert.rejects(llm.ask('p', null, { step: 'timeout-test' }), { name: 'TimeoutError' })
  assert.equal(signals.length, 2)
  assert.ok(signals.every((signal) => signal.aborted))
  assert.equal(llm.usage().calls, 0, '返答のない呼出の費用は未取得で、実際の課金0を意味しない')
})
