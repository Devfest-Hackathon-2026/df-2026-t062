// 事業所が足した書類の「拾う内容」（要約の項目）を、書式の欄から決める Gemini（#153・#209）。書式を使い始めるときに呼び、答えをそのまま項目にする。見直しは AI 特訓部屋（#154）でする。
// ログには中身（欄の言葉・案）を出さない。出すのは時間・トークン数・費用・エラーの種類だけ。
import { GoogleGenAI, Type } from '@google/genai'
import type { TopicDraft, TopicDrafter } from '../core/topics.ts'

// 単価（円／100万トークン）。api/gemini-chat.ts と同じ
const YEN_IN = 119
const YEN_OUT = 593
const MAX_TOPICS = 12

function prompt(kindName: string, slots: string[]): string {
  return [
    `介護の事業所が使う「${kindName}」という書類の書式を読み取りました。下は、その書式の欄に入る内容です。`,
    'ケアマネが訪問などで話した録音から、AI がこの書類を書きます。録音を、まず項目ごとに要約し、その要約から欄に書きます。',
    'この書類のための要約の項目を作ってください。',
    '- 1 つの項目は、録音で話に出る 1 つの話題（例: 体調、食事、家族の様子、次回までにすること）。書式の近い欄をまとめる',
    '- name は短い名前（20 字まで）。guide は、その項目に何をまとめるか（80 字まで。どの欄の材料になるかが分かるように）',
    `- ${MAX_TOPICS} 個まで。日付・氏名・事業所名・記入者のような、話から書かない欄のための項目は作らない。全体のまとめは別にあるので作らない`,
    '',
    '欄に入る内容:',
    ...slots.map((s) => `- ${s}`),
  ].join('\n')
}

export function geminiTopicDrafter(env: NodeJS.ProcessEnv): TopicDrafter {
  const model = env.GEMINI_MODEL ?? 'gemini-3.8-flash'
  const yenIn = Number(env.GEMINI_YEN_IN ?? YEN_IN)
  const yenOut = Number(env.GEMINI_YEN_OUT ?? YEN_OUT)
  let ai: GoogleGenAI | undefined
  return async ({ kindName, slots }) => {
    ai ??= new GoogleGenAI({ vertexai: true, project: env.GOOGLE_CLOUD_PROJECT, location: env.GEMINI_LOCATION ?? 'global' })
    const t0 = Date.now()
    try {
      const r = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt(kindName, slots) }] }],
        config: {
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: { topics: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, guide: { type: Type.STRING } }, required: ['name', 'guide'] } } },
            required: ['topics'],
          },
        },
      })
      const u = r.usageMetadata
      const p = u?.promptTokenCount ?? 0
      const o = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0)
      console.log(JSON.stringify({ severity: 'INFO', msg: 'topic draft gemini', ok: true, seconds: (Date.now() - t0) / 1000, promptTokens: p, outputTokens: o, yen: (p * yenIn + o * yenOut) / 1e6 }))
      const a = JSON.parse(r.text ?? '{}') as { topics?: TopicDraft[] }
      return (a.topics ?? []).filter((t) => t?.name?.trim()).slice(0, MAX_TOPICS).map((t) => ({ name: t.name.trim().slice(0, 40), guide: (t.guide ?? '').trim().slice(0, 400) }))
    } catch (e) {
      console.log(JSON.stringify({ severity: 'WARNING', msg: 'topic draft gemini', ok: false, seconds: (Date.now() - t0) / 1000, error: (e as Error)?.name ?? 'Error' }))
      throw e
    }
  }
}
