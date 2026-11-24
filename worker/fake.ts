// AI_PROVIDER=fake: 費用をかけずに流れを試すための中身。
// 何本目の録音かで、演習シナリオ（eval/scenario、公開・架空）の 1 回目・2 回目の記録と正解を返す。
import { readFileSync } from 'node:fs'
import { summaryTopics } from '../core/topics.ts'
import { ZERO_USAGE, type Person, type SpeakerAssigner, type Stt, type Summarizer, type TopicWriter, type TopicWriterInput, type Utterance } from './types.ts'
import type { Llm } from './vertex/gemini.ts'

const ROOT = new URL('../eval/scenario/', import.meta.url)
const load = (p: string) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'))

interface GenponEntry { id: string, speaker?: string, text: string }
interface Genpon { people: Record<string, { role: string, relation?: string }>, visits: { id: string, date: string, scenes: { entries: GenponEntry[] }[] }[] }

export class FakeStt implements Stt {
  async transcribe({ recordingId, sequence }: { recordingId: string, sequence: number }) {
    const g: Genpon = load('原本.json')
    const visit = g.visits[Math.min(sequence, g.visits.length) - 1]
    const utterances: Utterance[] = visit.scenes.flatMap((s) => s.entries).map((e, i) => ({
      id: `r${sequence}-${String(i + 1).padStart(4, '0')}`,
      startMs: i * 8000,
      endMs: i * 8000 + 7000,
      speaker: e.speaker ?? '記録',
      person: e.speaker ?? null,
      text: e.text,
    }))
    return { utterances, model: `fake:${recordingId.slice(0, 8)}`, audioSeconds: utterances.length * 8 }
  }
}

export class FakeSpeakers implements SpeakerAssigner {
  async assign({ utterances, people }: { utterances: Utterance[], people: Person[] }) {
    const g: Genpon = load('原本.json')
    const known = new Set(people.map((p) => p.label))
    const map: Record<string, string | null> = {}
    const newPeople: Person[] = []
    for (const u of utterances) {
      map[u.speaker] = u.person ?? null
      const label = u.person
      if (label && !known.has(label) && g.people[label]) {
        known.add(label)
        newPeople.push({ label, role: (g.people[label].role as Person['role']) ?? '不明', relation: g.people[label].relation ?? null })
      }
    }
    return { map, newPeople, usage: ZERO_USAGE }
  }
}

/** 要約の代わり。最初の項目に、発言の数だけを書いた要約を返す（中身は作らない） */
export class FakeSummarizer implements Summarizer {
  async summarize({ topics, utterances }: Parameters<Summarizer['summarize']>[0]) {
    const first = summaryTopics(topics)[0]
    return { texts: first ? { [first.id]: `（偽の要約）発言 ${utterances.length} 件` } : {}, usage: ZERO_USAGE }
  }
}

/** 要約から書く流れの代わり。演習シナリオの正解（2 本目からは 2 回目の正解）を返す */
export class FakeTopicWriter implements TopicWriter {
  async write({ summaries }: TopicWriterInput) {
    const later = summaries.some((s) => s.seq > 1)
    const raw = load(`gold/用紙/アセスメント_${later ? 'v2' : 'v1'}.json`)
    delete raw._comment
    const ids = summaries.map((s) => s.id)
    const values = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { value: v, cite: { kind: 'summary' as const, ids } }]))
    return { values, usage: ZERO_USAGE, failed: [], incompleteFields: [] }
  }
}

/** 様式の取り込みの AI の代わり。欄を 1 つも見つけない（ページと要確認だけの下書きになる）。流れを試すため */
/**
 * 試しの点検（費用なし）。番号が 5 の倍数の項目は段階 1（足りない情報つき）、ほかは基準のいちばん上の段階。
 * 画面の確かめ用で、書類の中身は見ない
 */
export const fakeInspect = (): Llm => {
  let calls = 0
  return {
    ask: async (_prompt, schema) => {
      calls++
      const props = (schema as { properties: { results: { properties: Record<string, { properties: { level: { enum: string[] } } }> } } }).properties.results.properties
      return {
        results: Object.fromEntries(Object.entries(props).map(([id, p]) => {
          const top = p.properties.level.enum.filter((l) => l !== '他').sort().at(-1) ?? '2'
          return [id, Number(id) % 5 === 0 ? { level: '1', met: {}, missing: '（試しの点検）記載が足りない' } : { level: top, met: {}, missing: null }]
        })),
      }
    },
    usage: () => ({ ...ZERO_USAGE, calls }),
  }
}

export const fakeFormImport = (): Llm => ({
  ask: async (_prompt, _schema, meta) => (meta.step === '様式の欄' ? { slots: [], localFields: [] } : { slots: [], fixes: [], removes: [], localFields: [] }),
  usage: () => ZERO_USAGE,
})

/** 書類を作るときに AI が書く（#195）の試用。どの欄も「書かない」と答える（値は変えない。費用なし） */
export const fakeDocumentFill = (): Llm => {
  let calls = 0
  return {
    ask: async (_prompt, schema) => {
      calls++
      const keys = Object.keys((schema as { properties: { fields: { properties: Record<string, unknown> } } }).properties.fields.properties)
      return { fields: Object.fromEntries(keys.map((k) => [k, { action: 'skip', value: null, from: [] }])) }
    },
    usage: () => ({ ...ZERO_USAGE, calls }),
  }
}

/** 記入済み原本の試用。内容を作らず、試用モードと明示する。 */
export const fakeDocumentRead = (): Llm => ({
  ask: async () => ({ entries: [], issues: ['試用モードのため原本の内容は読み取っていません。'] }),
  usage: () => ZERO_USAGE,
})
