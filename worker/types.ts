// worker の段の約束。中身（STT・Gemini）は差し替えられる（AI_PROVIDER=fake|vertex）。
import type { Cite } from '../core/apply-batch.ts'
import type { FormDef } from '../core/form.ts'
import type { Topic } from '../core/topics.ts'
import type { Llm } from './vertex/gemini.ts'

/** 原本の発言 1 つ（id は録音をまたいでも重ならない: r<録音の番号>-<連番>） */
export interface Utterance {
  id: string
  startMs: number | null
  endMs: number | null
  /** STT が振った話者の記号（speaker_1 など） */
  speaker: string
  /** 決まった人（people の label）。決められなければ null */
  person?: string | null
  text: string
}

export interface Person {
  label: string
  role: '本人' | '家族' | '専門職' | 'ケアマネ' | '不明'
  relation?: string | null
}

/** 2 層改に渡す記録の 1 回分（演習シナリオの原本.json の visits と同じ形） */
export interface Visit {
  id: string
  date: string
  scenes: { id: string, kind: '会話' | '観察' | '経過' | '書類', entries: { id: string, speaker: string | null, text: string, date?: string }[] }[]
}

export interface Usage {
  calls: number
  /** 入力（キャッシュに当たった分も含む） */
  promptTokens: number
  /** 入力のうち、キャッシュに当たった分（単価が安い） */
  cachedTokens: number
  outputTokens: number
  thinkingTokens: number
  /** 円（見込みの単価で計算） */
  yen: number
}

export interface SttResult {
  utterances: Utterance[]
  model: string
  /** 長い処理を続きから聞くための名前（Cloud Speech の operation） */
  operation?: string
  audioSeconds?: number
}

export interface Stt {
  transcribe(input: { uri: string, mime: string, recordingId: string, sequence: number, resumeOperation?: string, onOperation?: (name: string) => Promise<void> }): Promise<SttResult>
}

export interface SpeakerAssigner {
  assign(input: { utterances: Utterance[], people: Person[] }): Promise<{ map: Record<string, string | null>, newPeople: Person[], usage: Usage }>
}

export interface ProposedValue {
  value: unknown
  /** 根拠（2 層改は発言の id、要約から書くときは要約の行） */
  cite?: Cite
}

export interface WriterResult {
  values: Record<string, ProposedValue>
  usage: Usage
  /** 書けなかった 23 項目の番号など（一部だけ書けたとき） */
  failed: string[]
  /** AI が処理できなかった欄の key */
  incompleteFields: string[]
}

export interface SheetWriter {
  /**
   * 1 回目（その書類に AI が書いた値がない）: 記録の全部から書く。
   * 2 回目から: 今の値と新しい記録だけで直す（2 層改の工夫 3）。
   * 書く欄は form（録音がつながった書類の様式の版。その様式だけの欄の定義つき）から決める（core/dictionary.ts の writableFields）。
   */
  write(input: { visits: Visit[], newVisitId: string, current: Record<string, unknown>, people: Person[], first: boolean, form: FormDef }): Promise<WriterResult>
}

// ---------- 録音からの書き込み（作り替え。docs/再設計/17_録音からの書き込み.md） ----------

/** 使う要約の 1 行（録音 1 本・項目 1 つ。recording_summaries の 1 行） */
export interface SummaryLine {
  /** recording_summaries.id（値の根拠に残す） */
  id: string
  /** 項目の id */
  topic: string
  /** その書類につながった録音の何本目か（1 から） */
  seq: number
  /** 録音の日（日本の日付、YYYY-MM-DD） */
  date: string
  text: string
  /** 今回の録音の要約か */
  isNew: boolean
}

/** 3. 要約: 新しい録音を 1 回だけ全部読み、AI の項目ごとに要約する。話に出なかった項目は返さない */
export interface Summarizer {
  summarize(input: { kindName: string, topics: Topic[], utterances: Utterance[], people: Person[], records?: Visit[] }): Promise<{ texts: Record<string, string>, sourceIds?: Record<string, string[]>, usage: Usage }>
}

export interface TopicWriterInput {
  /** 原本の種類。書類なら書類専用の欄も候補に含める。省略時は会話 */
  sourceKind?: '会話' | '書類'
  /** 書類の種類の名前（form_kinds.name） */
  kindName: string
  /** 使う項目の一覧（全体の一覧に事業所の書き足しと足した項目を合わせたもの） */
  topics: Topic[]
  /** 使う要約（足していく種類は 1 回目から全部、単体の種類は今回の録音だけ） */
  summaries: SummaryLine[]
  /** 足していく種類の 2 回目から。欄を選ぶ AI に、今回足した分の印と、欄の今の値を見せる */
  showNew: boolean
  /** 書類の今の値 */
  current: Record<string, unknown>
  /** 録音がつながった書類の様式の版 */
  form: FormDef
}

/** 4〜7. 欄を選ぶ → 項目ごとに書く → 全体のまとめ → 最後のチェック。返す値の根拠は要約の行 */
export interface TopicWriter {
  write(input: TopicWriterInput): Promise<WriterResult>
}

export interface Providers {
  stt: Stt
  speakers: SpeakerAssigner
  writer: SheetWriter
  /** 録音からの書き込みの作り替え（要約から書く）。あれば 2 層改（writer）の代わりに使う（RECORDING_WRITER=summary） */
  recording?: { summarizer: Summarizer, writer: TopicWriter }
  /** 様式の取り込み（上げた PDF → 下書きの版）の AI。変換 1 回ごとに新しく作る（使った量を数える） */
  formImport: () => Llm
  /** 記入済み原本の画像読取と、録音と共通の要約・欄書き込み */
  documentRead?: () => Llm
  documentWrite?: NonNullable<Providers['recording']>
  /** AI 点検の AI。点検 1 回ごとに新しく作る（使った量を数える） */
  inspect?: () => Llm
}

export const ZERO_USAGE: Usage = { calls: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, thinkingTokens: 0, yen: 0 }
