// 版の欄の辞書（docs/再設計/16_書類と点検の基盤.md の「欄の辞書（版ごと）」）。
// fields.json の欄と、その版の local_fields（事業所の様式だけの欄。key は local. で始まる）を合わせる。
// 値の型の確かめ（core/schema.ts）・印字欄の直し（core/binding.ts）・AI の書き込み（core/apply-batch.ts）・
// 録音から AI が書いてよい欄（writableFields）・チャットの道具（api/chat.ts）は、どれもこの辞書を使う。
import { FIELD_LIST, type FieldSpec } from './fields.ts'

/**
 * その様式だけの欄の定義（版の local_fields の 1 つ）。fields.json の欄と同じ平らな形で、行やまとまりを持たない。
 * note は AI に欄の意味を伝える説明書き。note のない欄は、録音から AI が書かない
 */
export interface LocalField {
  key: string
  label: string
  type: 'text' | 'longtext' | 'date' | 'number' | 'enum' | 'bool'
  choices?: string[]
  note?: string
}

export interface FieldDict {
  /** 欄の定義（fields.json か、その版の local_fields）。どちらにもなければ undefined */
  get(key: string): FieldSpec | undefined
  /** 全部の欄（fields.json の順、そのあとに local_fields の順） */
  readonly list: readonly FieldSpec[]
}

const BY_KEY = new Map(FIELD_LIST.map((f) => [f.key, f]))

/** fields.json だけの辞書（local_fields のない版） */
export const GLOBAL_DICT: FieldDict = { get: (key) => BY_KEY.get(key), list: FIELD_LIST }

const toSpec = (f: LocalField): FieldSpec => ({
  key: f.key, label: f.label, type: f.type, local: true,
  ...(f.choices?.length ? { choices: f.choices } : {}),
  ...(f.note?.trim() ? { note: f.note.trim() } : {}),
})

const dicts = new WeakMap<readonly LocalField[], FieldDict>()

/** 版の欄の辞書。local_fields がなければ fields.json だけ（同じ local_fields には同じ辞書を返す） */
export function fieldDict(localFields: readonly LocalField[] | undefined): FieldDict {
  if (!localFields?.length) return GLOBAL_DICT
  const hit = dicts.get(localFields)
  if (hit) return hit
  // local_fields は local. で始まるので fields.json の key とは重ならない（公開前の確かめで止める）。重なっても fields.json を先にする
  const local = localFields.filter((f) => !BY_KEY.has(f.key)).map(toSpec)
  const byLocal = new Map(local.map((f) => [f.key, f]))
  const d: FieldDict = { get: (key) => BY_KEY.get(key) ?? byLocal.get(key), list: [...FIELD_LIST, ...local] }
  dicts.set(localFields, d)
  return d
}

/** 録音から書いてよい出どころ: 会話・書類（書類の記録があるときだけ。worker/vertex の needsDocument）・案 */
const fromRecording = (s: string) => s === 'talk' || s === 'draft' || s.startsWith('doc:')

/**
 * AI が書いてよい欄か（AI の書き込みの計画で使う）。出どころがケアマネの判断・事業所の設定・その場で聞くことだけの欄は書かない。
 * その様式だけの欄は、説明書き（note）があるものだけ
 */
export function aiMayWrite(key: string, dict: FieldDict = GLOBAL_DICT): boolean {
  const f = dict.get(key)
  if (!f) return false
  if (f.local) return !!f.note
  const src = f.source ?? []
  if (src.length === 0) return true
  return src.some((s) => s === 'talk' || s.startsWith('doc:') || s === 'draft' || s === 'derived')
}

/**
 * 録音から AI が書いてよい欄（docs/再設計/16 の「録音から AI が書く欄」）。
 * 録音がつながった書類の様式の版が読む欄のうち、出どころに会話・書類・案がある欄（図は除く）。その様式だけの欄は、説明書き（note）があるもの。
 * 並びは fields.json の順、そのあとに local_fields の順（AI への指示文の並びを変えないため）
 */
export function writableFields(form: { keys: readonly string[], localFields?: readonly LocalField[] }): FieldSpec[] {
  const keys = new Set(form.keys)
  return fieldDict(form.localFields).list.filter((f) => {
    if (!keys.has(f.key) || f.type === 'image') return false
    return f.local ? !!f.note : (f.source ?? []).some(fromRecording)
  })
}
