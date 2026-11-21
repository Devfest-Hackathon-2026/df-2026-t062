// 書き方の相談の Gemini（Vertex AI、関数呼び出し）。道具は自動では動かさず、呼び出しの部品を api/chat.ts に返す。
// ログには中身（指示文・答え・用紙の値・エラーの文面）を出さない。出すのは回数・時間・トークン数・費用・エラーの種類だけ。
import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai'
import type { ChatModel, Part } from './chat.ts'
import { setTimeout as delay } from 'node:timers/promises'

// 単価（円／100万トークン）。worker/vertex/gemini.ts と同じ（Gemini 3.8 Flash の global の特別価格、2026-12-31 まで）
const YEN_IN = 119
const YEN_OUT = 593

export function geminiChatModel(env: NodeJS.ProcessEnv, opts: { retries?: number, client?: Pick<GoogleGenAI, 'models'> } = {}): ChatModel {
  const model = env.GEMINI_MODEL ?? 'gemini-3.8-flash'
  const yenIn = Number(env.GEMINI_YEN_IN ?? YEN_IN)
  const yenOut = Number(env.GEMINI_YEN_OUT ?? YEN_OUT)
  const retries = opts.retries ?? 1
  let ai = opts.client
  return async ({ system, contents, tools, final, signal }) => {
    ai ??= new GoogleGenAI({ vertexai: true, project: env.GOOGLE_CLOUD_PROJECT, location: env.GEMINI_LOCATION ?? 'global' })
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      const t0 = Date.now()
      try {
        const r = await ai.models.generateContent({
          model,
          contents,
          // final: 道具は宣言したまま（会話に道具の呼び出しがあるので）、呼ばせずに文で答えさせる
          config: { systemInstruction: system, tools: [{ functionDeclarations: tools }], maxOutputTokens: 8192, abortSignal: signal, httpOptions: { timeout: 60000, retryOptions: { attempts: 1 } }, ...(final ? { toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } } } : {}) },
        })
        const u = r.usageMetadata
        const prompt = u?.promptTokenCount ?? 0
        const output = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0)
        const c = r.candidates?.[0]
        const parts = (c?.content?.parts ?? []) as Part[]
        // 部品の種類だけを出す（文・道具の名前・考え）。中身は出さない
        const kinds = parts.map((p) => (p.functionCall ? `call:${p.functionCall.name}` : p.thought ? 'thought' : p.text ? 'text' : 'other'))
        console.log(JSON.stringify({ severity: 'INFO', msg: 'chat gemini', ok: true, attempt, final: !!final, finishReason: c?.finishReason ?? null, parts: kinds, seconds: (Date.now() - t0) / 1000, promptTokens: prompt, outputTokens: output, yen: (prompt * yenIn + output * yenOut) / 1e6 }))
        return parts
      } catch (e) {
        console.log(JSON.stringify({ severity: 'WARNING', msg: 'chat gemini', ok: false, attempt, seconds: (Date.now() - t0) / 1000, error: (e as Error)?.name ?? 'Error', status: (e as { status?: number })?.status ?? null }))
        const status = Number((e as { status?: unknown, code?: unknown })?.status ?? (e as { code?: unknown })?.code)
        if (attempt >= retries || signal?.aborted || ![408, 429, 500, 502, 503, 504].includes(status)) throw e
        await delay(1500 * 2 ** attempt, undefined, { signal })
      }
    }
  }
}
