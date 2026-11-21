// 書類の種類ごとの「まとめる項目」（form_kinds.topics）と、事業所が直した項目（office_topics）を合わせた一覧。
// docs/再設計/17_録音からの書き込み.md の「まとめる項目」「事業所が直せる項目」。
import { createHash } from 'node:crypto'

/** まとめる項目の 1 つ */
export interface Topic {
  /** 項目の id。名前を変えても変えない */
  id: string
  name: string
  /** 何をまとめるか。要約する AI と、欄を選ぶ AI への手がかり（最後のチェックには渡さない） */
  guide: string
  /** ai: AI が要約して書く。machine: 機械で入れる（その日の日付） */
  by: 'ai' | 'machine'
  /** 最後に書く項目（全体のまとめ） */
  last: boolean
  /** machine の項目だけ。入れる欄（1 回目の欄、2 回目からの欄） */
  keys?: { first: string, later: string }
}

/** 事業所が直した項目（office_topics の 1 行）。全体の一覧との差分だけ */
export interface OfficeTopics {
  /** 足した項目（AI がまとめる項目。最後に書く項目・機械の項目は足せない） */
  added: { id: string, name: string, guide: string }[]
  /** 全体の項目の説明への書き足し（項目の id → 文） */
  notes: Record<string, string>
}

/**
 * 録音の処理が使う一覧: 全体の一覧に、事業所の書き足しと、足した項目を合わせる。
 * 書き足しは全体の項目の説明のあとに足す（全体から消えた項目への書き足しは使わない）。
 * 足した項目は、AI がまとめる全体の項目のあと、最後に書く項目と機械の項目の前に置く
 */
export function topicsFor(base: readonly Topic[], office?: OfficeTopics | null): Topic[] {
  if (!office) return base.map((t) => ({ ...t }))
  const join = (guide: string, note: string | undefined) => [guide.trim(), (note ?? '').trim()].filter(Boolean).join(' ')
  const merged = base.map((t) => ({ ...t, guide: join(t.guide, office.notes[t.id]) }))
  const ids = new Set(base.map((t) => t.id))
  const added: Topic[] = office.added.filter((t) => !ids.has(t.id)).map((t) => ({ id: t.id, name: t.name, guide: t.guide.trim(), by: 'ai', last: false }))
  const tail = merged.findIndex((t) => t.by !== 'ai' || t.last)
  if (tail < 0) return [...merged, ...added]
  return [...merged.slice(0, tail), ...added, ...merged.slice(tail)]
}

/** 使った一覧の指紋（事業所が直す前と後で、書き込みを比べられるように jobs.steps に残す） */
export function topicsFingerprint(topics: readonly Topic[]): string {
  const canon = topics.map((t) => [t.id, t.name, t.guide, t.by, t.last, t.keys?.first ?? null, t.keys?.later ?? null])
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16)
}

/** AI が要約する項目（機械の項目を除く。最後に書く項目も、話に出れば要約する） */
export const summaryTopics = (topics: readonly Topic[]) => topics.filter((t) => t.by === 'ai')
