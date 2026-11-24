// fields.json（欄の一覧の本体）を読む。画面・api・worker で共通に使う。
import FIELDS_JSON from './fields.json' with { type: 'json' }

export type FieldType =
  | 'text' | 'longtext' | 'date' | 'number' | 'bool' | 'enum' | 'multi' | 'image' | 'object' | 'list'

export interface FieldSpec {
  key: string
  label: string
  type: FieldType
  choices?: string[] | string
  of?: string
  fields?: FieldSpec[]
  source?: string[]
  forms?: Record<string, string>
  format?: 'time'
  note?: string
  /** この欄に意味があるときの前提。欄なら欄の key、中の項目なら同じまとまりの中の項目の key → 値の一覧 */
  requires?: Record<string, (string | boolean | number)[]>
  /** 選択肢にない言い方を入れる詳しい欄（同じまとまりの中の項目の key） */
  detail?: string
  /** list の行を見分ける項目の key。"order" は行の並びの順で見分ける */
  rowKey?: string
  /** その様式だけの欄（版の local_fields。core/dictionary.ts が作る）。fields.json の欄にはない */
  local?: true
}

interface FieldsFile {
  meta: unknown
  forms: unknown
  required: { assess: { keys: (string | string[])[] } }
  choiceSets: Record<string, string[]>
  types: Record<string, { label: string, fields: FieldSpec[] }>
  fields: (FieldSpec | { group: string })[]
}

export const FIELDS = FIELDS_JSON as unknown as FieldsFile

export const FIELD_LIST: FieldSpec[] = FIELDS.fields.filter((f): f is FieldSpec => 'key' in f && !!f.key)

export const BY_KEY = new Map(FIELD_LIST.map((f) => [f.key, f]))

export function spec(key: string): FieldSpec | undefined {
  return BY_KEY.get(key)
}

export function choicesOf(f: Pick<FieldSpec, 'choices'>): string[] {
  if (!f.choices) return []
  return typeof f.choices === 'string' ? FIELDS.choiceSets[f.choices] ?? [] : f.choices
}

export function subFieldsOf(f: FieldSpec): FieldSpec[] {
  return f.fields ?? (f.of ? FIELDS.types[f.of]?.fields ?? [] : [])
}

/** アセスメントの必須の欄（配列の要素は「どれか 1 つに値があればよい」組） */
export const REQUIRED_ASSESS: (string | string[])[] = FIELDS.required.assess.keys
