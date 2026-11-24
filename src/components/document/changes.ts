// 変更の見せ方: 案のカードに出す差分と、まだ保存していない変更の数
import { splitSentences } from '../../../core/diff.ts'
import { GLOBAL_DICT, type FieldDict } from '../../../core/dictionary.ts'
import { subFieldsOf, type FieldSpec } from '../../../core/fields.ts'

/** 案のカードに出す差分。文の途中で切らずに、前にだけある文（消える）と、新しい方にだけある文（足す）を出す */
export function sentenceChanges(before: string | null, after: string): { del: string[], ins: string[] } {
  const b = splitSentences(before ?? '').map((x) => x.trim()).filter(Boolean)
  const a = splitSentences(after).map((x) => x.trim()).filter(Boolean)
  return { del: b.filter((x) => !a.includes(x)), ins: a.filter((x) => !b.includes(x)) }
}

const blank = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

function shown(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ'
  if (Array.isArray(v)) return v.map(shown).join('、')
  if (v && typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** まとまりの値を「項目の名前：値」の行にする（表は「n 行目」を前に付ける） */
function lines(f: FieldSpec, v: unknown): string[] {
  if (blank(v)) return []
  const subs = subFieldsOf(f)
  const row = (r: unknown, head: string) => subs.flatMap((s) => {
    const x = (r as Record<string, unknown> | null)?.[s.key]
    return blank(x) ? [] : [`${head}${s.label}：${shown(x)}`]
  })
  if (f.type === 'object') return row(v, '')
  if (f.type === 'list' && Array.isArray(v)) return v.flatMap((r, i) => row(r, `${i + 1} 行目 `))
  return [shown(v)]
}

/** 案のカードに出す差分。文章の欄は文ごと、ほかの欄は「項目の名前：値」の行ごとに、消えるものと足すものを出す */
export function proposalChanges(key: string, before: unknown, after: unknown, dict: FieldDict = GLOBAL_DICT): { del: string[], ins: string[] } {
  const f = dict.get(key)
  if (!f || f.type === 'text' || f.type === 'longtext') return sentenceChanges(typeof before === 'string' ? before : null, typeof after === 'string' ? after : '')
  const b = lines(f, before)
  const a = lines(f, after)
  return { del: b.filter((x) => !a.includes(x)), ins: a.filter((x) => !b.includes(x)) }
}

export const countText = (c: { ai: number, hand: number }) =>
  c.ai || c.hand ? `未保存: AI の変更 ${c.ai} か所${c.hand ? `・手入力 ${c.hand} 欄` : ''}` : ''
