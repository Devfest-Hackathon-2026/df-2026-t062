// 責任者のダメ出し（一言）を、どの項目に足すか振り分ける Gemini（#115 の AI 特訓部屋）。保存はしない（api が答えを一覧と照らして画面に返す）。
// ログには中身（一言・項目）を出さない。出すのは時間・トークン数・費用・エラーの種類だけ。
import { GoogleGenAI, Type } from '@google/genai'
import type { TeachDecision, TeachInput, TopicTeacher } from '../core/topics.ts'

// 単価（円／100万トークン）。api/gemini-chat.ts と同じ
const YEN_IN = 119
const YEN_OUT = 593

function prompt({ kindName, items, current, text }: TeachInput): string {
  const cur = items.find((i) => i.id === current)
  return [
    `介護の事業所の責任者が、録音から「${kindName}」を書く AI に、書いてほしいことを一言で教えました。`,
    'AI は、録音をまず下の項目ごとに要約し、その要約から書類の欄に書きます。項目の説明は、要約するときの手がかりになります。',
    'この一言を、どの項目の説明に 1 行足せばよいかを決めてください。',
    '- note: どれか 1 つの項目に足す。line は、説明に足す 1 行（60 字まで。「〜も書く」「〜は数字のまま書く」のような、要約する AI への頼み）',
    '- new: どの項目にも当てはまらない。name は新しい項目の短い名前（20 字まで）、guide はその項目にまとめること（80 字まで）',
    '- ask: 意味が二通り以上に取れて、足す項目か中身が変わるときだけ。question は短い聞き返し、options は選択肢（2〜4 個。label は短く、topicId と line は note と同じ）',
    '- refuse: 話に出ていないことを書かせる頼み（それらしく埋める、推測で書く、など）。message は断る理由を、責任者に向けた丁寧な一文で',
    cur ? `責任者は今、項目「${cur.name}」（id: ${cur.id}）を見ています。一言がこの項目の話なら、この項目に足してください。` : '責任者は、どの項目も開いていません。',
    '',
    '項目（id: 名前 — 説明）:',
    ...items.map((i) => `- ${i.id}: ${i.name} — ${i.guide}`),
    '',
    `責任者の一言: ${text}`,
  ].join('\n')
}

export function geminiTopicTeacher(env: NodeJS.ProcessEnv): TopicTeacher {
  const model = env.GEMINI_MODEL ?? 'gemini-3.8-flash'
  const yenIn = Number(env.GEMINI_YEN_IN ?? YEN_IN)
  const yenOut = Number(env.GEMINI_YEN_OUT ?? YEN_OUT)
  let ai: GoogleGenAI | undefined
  return async (input) => {
    ai ??= new GoogleGenAI({ vertexai: true, project: env.GOOGLE_CLOUD_PROJECT, location: env.GEMINI_LOCATION ?? 'global' })
    const t0 = Date.now()
    const option = { type: Type.OBJECT, properties: { label: { type: Type.STRING }, topicId: { type: Type.STRING, enum: input.items.map((i) => i.id) }, line: { type: Type.STRING } }, required: ['label', 'topicId', 'line'] }
    try {
      const r = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt(input) }] }],
        config: {
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              type: { type: Type.STRING, enum: ['note', 'new', 'ask', 'refuse'] },
              topicId: { type: Type.STRING }, line: { type: Type.STRING },
              name: { type: Type.STRING }, guide: { type: Type.STRING },
              question: { type: Type.STRING }, options: { type: Type.ARRAY, items: option },
              message: { type: Type.STRING },
            },
            required: ['type'],
          },
        },
      })
      const u = r.usageMetadata
      const p = u?.promptTokenCount ?? 0
      const o = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0)
      console.log(JSON.stringify({ severity: 'INFO', msg: 'topic teach gemini', ok: true, seconds: (Date.now() - t0) / 1000, promptTokens: p, outputTokens: o, yen: (p * yenIn + o * yenOut) / 1e6 }))
      const a = JSON.parse(r.text ?? '{}') as Record<string, any>
      const s = (v: unknown) => (typeof v === 'string' ? v : '')
      const d: TeachDecision =
        a.type === 'note' ? { type: 'note', topicId: s(a.topicId), line: s(a.line) }
        : a.type === 'ask' ? { type: 'ask', question: s(a.question), options: Array.isArray(a.options) ? a.options.map((x: any) => ({ label: s(x?.label), topicId: s(x?.topicId), line: s(x?.line) })) : [] }
        : a.type === 'refuse' ? { type: 'refuse', message: s(a.message) || '話に出ていないことは書けません。' }
        : { type: 'new', name: s(a.name), guide: s(a.guide) }
      return d
    } catch (e) {
      console.log(JSON.stringify({ severity: 'WARNING', msg: 'topic teach gemini', ok: false, seconds: (Date.now() - t0) / 1000, error: (e as Error)?.name ?? 'Error' }))
      throw e
    }
  }
}
