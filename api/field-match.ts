// 責任者が書いた「ここに何が入るか」を、欄の一覧に当てはめる Gemini（#102）。当たらなければ null（呼ぶ側が、その様式だけの欄を作る）。
// ログには中身（責任者の言葉・答え）を出さない。出すのは時間・トークン数・費用・エラーの種類だけ。
import { GoogleGenAI, Type } from '@google/genai'
import type { FieldCandidate, FieldMatcher } from '../core/slot-meaning.ts'

// 単価（円／100万トークン）。api/gemini-chat.ts と同じ
const YEN_IN = 119
const YEN_OUT = 593

const line = (c: FieldCandidate) => [
  c.id, c.label, c.type,
  c.choices?.length ? `選択肢: ${c.choices.join(' / ')}` : '',
  c.list ? '行のある欄（何行目かを row で答える）' : '',
  c.note ? `説明: ${c.note.replace(/\s+/g, ' ').slice(0, 80)}` : '',
].filter(Boolean).join('\t')

function prompt(text: string, mark: boolean, candidates: FieldCandidate[]): string {
  return [
    '介護の書類の用紙の 1 つの欄について、事業所の責任者が「ここに何が入るか」を書きました。',
    mark ? 'この欄は、丸や ✓ を付ける欄です。どの欄が、どの値のときに印を付けるかを選んでください。' : 'この欄は、文字を書く欄です。',
    '次の一覧から、書かれたものと同じ意味の欄を 1 つ選んでください。同じ意味の欄がなければ、id を空にしてください。似ているだけの欄は選ばないでください。',
    '',
    `責任者の言葉: ${text}`,
    '',
    '一覧（id、名前、型、そのほか。タブ区切り）:',
    ...candidates.map(line),
  ].join('\n')
}

export function geminiFieldMatcher(env: NodeJS.ProcessEnv): FieldMatcher {
  const model = env.GEMINI_MODEL ?? 'gemini-3.8-flash'
  const yenIn = Number(env.GEMINI_YEN_IN ?? YEN_IN)
  const yenOut = Number(env.GEMINI_YEN_OUT ?? YEN_OUT)
  let ai: GoogleGenAI | undefined
  return async ({ text, mark, candidates }) => {
    ai ??= new GoogleGenAI({ vertexai: true, project: env.GOOGLE_CLOUD_PROJECT, location: env.GEMINI_LOCATION ?? 'global' })
    const t0 = Date.now()
    try {
      const r = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt(text, mark, candidates) }] }],
        config: {
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: { id: { type: Type.STRING }, row: { type: Type.INTEGER }, choice: { type: Type.STRING } },
            required: ['id'],
          },
        },
      })
      const u = r.usageMetadata
      const p = u?.promptTokenCount ?? 0
      const o = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0)
      console.log(JSON.stringify({ severity: 'INFO', msg: 'field match gemini', ok: true, seconds: (Date.now() - t0) / 1000, promptTokens: p, outputTokens: o, yen: (p * yenIn + o * yenOut) / 1e6 }))
      const a = JSON.parse(r.text ?? '{}') as { id?: string, row?: number, choice?: string }
      const hit = a.id ? candidates.find((c) => c.id === a.id) : undefined
      if (!hit) return null
      return { id: hit.id, ...(hit.list && a.row && a.row > 0 ? { row: a.row } : {}), ...(a.choice ? { choice: a.choice } : {}) }
    } catch (e) {
      console.log(JSON.stringify({ severity: 'WARNING', msg: 'field match gemini', ok: false, seconds: (Date.now() - t0) / 1000, error: (e as Error)?.name ?? 'Error' }))
      throw e
    }
  }
}
