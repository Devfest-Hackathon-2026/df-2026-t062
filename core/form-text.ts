// 書類の値を「欄の名前: 値」の文にする（AI 点検が書類を読む部品。docs/再設計/16_書類と点検の基盤.md の「流れ」の 1）。
// 版が読む欄だけを、欄の辞書の順に出す。空の欄は出さない。まとまりの欄・表は中の項目の名前で書く。
import type { FieldDict } from './dictionary.ts'
import { subFieldsOf, type FieldSpec } from './fields.ts'

const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === ''
  || (Array.isArray(v) && (v.length === 0 || v.every(isEmpty)))
  || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(isEmpty))

/** 1 つの値を文に。sub はまとまりの欄・表の中の項目 */
function show(v: unknown, f: FieldSpec | undefined): string {
  if (f?.type === 'image') return '（図あり）'
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ'
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object' || x === null)) return v.filter((x) => !isEmpty(x)).join('、')
    return v.filter((x) => !isEmpty(x)).map((row) => `〔${show(row, f)}〕`).join(' ')
  }
  if (v && typeof v === 'object') {
    const subs = f ? subFieldsOf(f) : []
    const label = (k: string) => subs.find((s) => s.key === k)
    return Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => !isEmpty(x))
      .map(([k, x]) => `${label(k)?.label ?? k}=${show(x, label(k))}`)
      .join('、')
  }
  return JSON.stringify(v)
}

/** 版が読む欄（keys）のうち、値のある欄を「欄の名前: 値」の行にする */
export function formText(dict: FieldDict, keys: readonly string[], values: Readonly<Record<string, unknown>>): string {
  const want = new Set(keys)
  const lines: string[] = []
  for (const f of dict.list) {
    if (!want.has(f.key) || isEmpty(values[f.key])) continue
    lines.push(`${f.label}: ${show(values[f.key], f)}`)
  }
  return lines.join('\n')
}
