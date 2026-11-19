// 録音からの書き込み（作り替え）の 3. 要約。docs/再設計/17_録音からの書き込み.md の「要約」。
// 新しい録音の文字起こしを 1 回だけ全部読み、AI がまとめる項目ごとに要約する。話に出なかった項目は返さない。
// ログには中身を出さない（数だけ）。
import { summaryTopics, type Topic } from '../../core/topics.ts'
import type { Person, Summarizer, Utterance } from '../types.ts'
import type { Llm } from './gemini.ts'
import * as P from './topic-prompts.ts'

const fmtPeople = (people: Person[]) => people.map((p) => `- ${p.label}: ${p.role}${p.relation ? `（${p.relation}）` : ''}`).join('\n') || '（まだ分からない）'
const fmtUtterances = (us: Utterance[]) => us.map((u) => `[${u.id}] ${u.person ?? u.speaker}: ${u.text}`).join('\n')
/** 項目の一覧（id: 名前 — 説明）。最後に書く項目には、そのことを添える */
export const fmtTopics = (topics: readonly Topic[]) =>
  topics.map((t) => `- ${t.id}: ${t.name}${t.guide ? ` — ${t.guide}` : ''}${t.last ? '（最後に、ほかの欄を書いたあとで書く）' : ''}`).join('\n')

export function summarizer(newLlm: () => Llm): Summarizer {
  return {
    async summarize({ kindName, topics, utterances, people }) {
      const ai = summaryTopics(topics)
      const llm = newLlm()
      const prompt = P.fill(P.SUMMARIZE, { kind: kindName, people: fmtPeople(people), entries: fmtUtterances(utterances), topics: fmtTopics(ai) })
      const schema = {
        type: 'object',
        properties: {
          summaries: {
            type: 'object',
            properties: Object.fromEntries(ai.map((t) => [t.id, { anyOf: [{ type: 'string' }, { type: 'null' }] }])),
          },
        },
        required: ['summaries'],
      }
      const r = await llm.ask(prompt, schema, { step: '要約' }) as { summaries?: Record<string, unknown> } | null
      const got = r && typeof r === 'object' && r.summaries && typeof r.summaries === 'object' ? r.summaries : {}
      const texts: Record<string, string> = {}
      for (const t of ai) {
        const v = got[t.id]
        if (typeof v === 'string' && v.trim()) texts[t.id] = v.trim()
      }
      const usage = llm.usage()
      console.log(JSON.stringify({ severity: 'INFO', msg: 'summarizer done', topics: ai.length, summaries: Object.keys(texts).length, utterances: utterances.length, calls: usage.calls, promptTokens: usage.promptTokens, yen: usage.yen }))
      return { texts, usage }
    },
  }
}
