// AI 点検の中身（docs/再設計/16_書類と点検の基盤.md の「流れ」の 2・3）。DB には触らない（job.ts が集めて残す）。
//   2. プログラムで判定（core/checks/rules.ts）。段階が決まった項目は AI に聞かない
//   3. 残りを AI で判定。項目を分けて聞き、指示文の先頭（書類）をそろえる
// 項目ごとに、段階・観点の当否・段階が 1 のときの足りない情報・押したときに移る欄を返す。
import { inspectableItems, LEVELS, type CheckItem, type CheckSet, type Level } from '../../core/checks/index.ts'
import { RULES } from '../../core/checks/rules.ts'
import { fieldDict } from '../../core/dictionary.ts'
import type { FormDef } from '../../core/form.ts'
import { formText } from '../../core/form-text.ts'
import type { Usage } from '../types.ts'
import type { Llm } from '../vertex/gemini.ts'
import * as P from './prompt.ts'

export interface InspectDoc {
  id: string
  /** 書類の種類（form_kinds.key） */
  kind: string
  /** 書類の種類の名前（form_kinds.name） */
  kindName: string
  form: Pick<FormDef, 'keys' | 'localFields'>
  values: Record<string, unknown>
}

export interface Finding {
  item: string
  /** 判定できなかった（AI の答えが基準にない段階だった）ときは null */
  level: Level | null
  /** 観点（①②…）ごとの当否。精度の確かめに使い、画面には出さない */
  met: Record<string, boolean>
  /** 段階が 1 のときだけ */
  missing: string | null
  /** 押したときに移る欄（keys のうち、その書類の版にある最初の欄）。null は用紙に欄なし */
  fieldKey: string | null
  /** fieldKey のある書類 */
  documentId: string | null
  by: 'rule' | 'ai'
}

/** 1 回に聞く項目の数（答えの形が大きくなりすぎないように） */
export const CHUNK = 16

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

/** 段階 1 なのに足りない情報がないときの言葉 */
const fallbackMissing = (i: CheckItem) => `${i.name}の記載が足りない`

export async function inspect({ set, docs, llm }: { set: CheckSet, docs: InspectDoc[], llm: Llm }): Promise<{ findings: Finding[], usage: Usage, ruleItems: number, aiItems: number }> {
  const items = inspectableItems(set, new Set(docs.map((d) => d.kind)))
  const docsOf = (i: CheckItem) => docs.filter((d) => i.docs.includes(d.kind))
  const texts = new Map(docs.map((d) => [d.id, formText(fieldDict(d.form.localFields), d.form.keys, d.values)]))

  const jump = (i: CheckItem): Pick<Finding, 'fieldKey' | 'documentId'> => {
    for (const d of docsOf(i)) {
      const k = i.keys.find((key) => d.form.keys.includes(key))
      if (k) return { fieldKey: k, documentId: d.id }
    }
    return { fieldKey: null, documentId: null }
  }

  // 2. プログラムで判定
  const decided = new Map<string, Finding>()
  const met = new Map<string, Record<string, boolean>>()
  for (const i of items) {
    const rule = RULES[i.id]
    if (!rule || i.method === 'ai') continue
    const ds = docsOf(i)
    const r = rule({ values: Object.assign({}, ...ds.map((d) => d.values)), text: ds.map((d) => texts.get(d.id)).join('\n') })
    if (r && 'level' in r) decided.set(i.id, { item: i.id, level: r.level, met: {}, missing: r.level === '1' ? r.missing ?? fallbackMissing(i) : null, ...jump(i), by: 'rule' })
    else if (r) met.set(i.id, r.met)
    else if (i.method === 'rule') throw new Error(`rule の項目 ${i.id} の段階が決まらない`)
  }

  // 3. 残りを AI で判定。先頭（書類）は同じにする
  const rest = items.filter((i) => !decided.has(i.id))
  const prefix = P.head(docs.map((d) => ({ kindName: d.kindName, text: texts.get(d.id)! })))
  for (const group of chunks(rest, CHUNK)) {
    const r = await llm.ask(prefix + P.body(group, met), P.schema(group), { step: '点検' }) as { results?: Record<string, { level?: unknown, met?: unknown, missing?: unknown }> } | null
    for (const i of group) {
      const a = r?.results?.[i.id]
      const level = LEVELS.find((l) => l === a?.level && i.levels[l]) ?? null
      const aiMet = a?.met && typeof a.met === 'object' ? Object.fromEntries(Object.entries(a.met).filter(([k, v]) => i.criteria.some((c) => c.mark === k) && typeof v === 'boolean')) as Record<string, boolean> : {}
      const missing = level === '1' ? (typeof a?.missing === 'string' && a.missing.trim() ? a.missing.trim().slice(0, 80) : fallbackMissing(i)) : null
      decided.set(i.id, { item: i.id, level, met: { ...aiMet, ...met.get(i.id) }, missing, ...jump(i), by: 'ai' })
    }
  }

  return { findings: items.map((i) => decided.get(i.id)!), usage: llm.usage(), ruleItems: items.length - rest.length, aiItems: rest.length }
}
