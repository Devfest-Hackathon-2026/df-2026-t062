// AI 点検の物差し（点検項目のデータ）。docs/再設計/16_書類と点検の基盤.md の「物差し」「点検できる範囲」「見せ方」。
// 物差しはリポジトリのデータ（版つき）。DB には名前と版（check_set）と中身の指紋（check_set_sha）だけを持つ。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export type Level = '1' | '2' | '3' | '他'
export const LEVELS: readonly Level[] = ['1', '2', '3', '他']

export interface CheckItem {
  /** 点検項目の番号（'1'〜'62'） */
  id: string
  name: string
  /** 見る書類の種類（form_kinds.key。どれか 1 つがあれば点検できる） */
  docs: string[]
  /** 段階と基準（出典のまま） */
  levels: Partial<Record<Level, string>>
  /** 段階を決める下位の観点（①②…。出典のまま） */
  criteria: { mark: string, text: string }[]
  /** 基準に添えた注（出典の【】） */
  notes: string[]
  /** ケアプラン点検支援ツールの「分類」 */
  category: string
  /** 運営基準に関わる項目か（ツールの ●） */
  operational: boolean
  /** 判定のしかた。rule・both は core/checks/rules.ts に関数がある */
  method: 'rule' | 'ai' | 'both'
  /** 先に見る欄（手がかり）。画面で項目を押したときに移る欄にも使う。空なら用紙に決まった欄がない */
  keys: string[]
  /** 確認の必要性と留意事項（自分の言葉。AI の指示文に使う） */
  guide: string
}

export interface CheckSet {
  name: string
  version: string
  source: { title: string, url: string, note: string }
  items: CheckItem[]
}

const load = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')) as CheckSet
const SETS: Record<string, CheckSet> = Object.fromEntries([load('./mhlw-careplan.json')].map((s) => [`${s.name}@${s.version}`, s]))

/** 今使う物差し（POST /api/clients/:id/inspections の checkSet の既定） */
export const DEFAULT_CHECK_SET = 'mhlw-careplan@2026-03'

/** 名前と版（例 mhlw-careplan@2026-03）で物差しを引く。ないときは投げる */
export function checkSet(id: string): CheckSet {
  const s = SETS[id]
  if (!s) throw new Error(`物差しがありません: ${id}`)
  return s
}
export const hasCheckSet = (id: string) => id in SETS

/** 物差しの中身の指紋（16 桁）。どの中身で点検したかを残す */
export const checkSetSha = (s: CheckSet) => createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16)

/** 点検できる項目（利用者にある書類の種類で決まる）。ほかは「点検していない」で、判定にも一覧にも入れない */
export const inspectableItems = (s: CheckSet, kinds: ReadonlySet<string>) => s.items.filter((i) => i.docs.some((d) => kinds.has(d)))

/** 満たしているか。「他」は足りない項目に数えない */
export const isSatisfied = (level: Level) => level !== '1'

export type Verdict = '要確認' | '適合'
/** 書類の判定: 段階 1 が 1 つでもあれば要確認、どれも 2 以上（か他）なら適合 */
export const verdictOf = (levels: Iterable<Level>): Verdict => ([...levels].some((l) => !isSatisfied(l)) ? '要確認' : '適合')

/** レーダーチャートの順（アセスメントの 5 つ → ケアプランの分類） */
const CATEGORY_ORDER = ['生活の全体像の把握', '疾病・心身状態の把握', '主訴・意思の把握・尊重', '課題の分析', '家族の状況の把握と支援', '課題を解決するためのサービス計画', '多職種との連携', 'その他']

export interface CategoryCount { category: string, satisfied: number, total: number }
/** 分類ごとの「満たしている項目の数 / 項目の数」。段階のない項目（点検できなかった）は数えない */
export function categoryCounts(items: readonly CheckItem[], levels: ReadonlyMap<string, Level>): CategoryCount[] {
  const out = new Map<string, CategoryCount>()
  for (const i of items) {
    const l = levels.get(i.id)
    if (!l) continue
    const c = out.get(i.category) ?? { category: i.category, satisfied: 0, total: 0 }
    c.total++
    if (isSatisfied(l)) c.satisfied++
    out.set(i.category, c)
  }
  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c)
    return i < 0 ? CATEGORY_ORDER.length : i
  }
  return [...out.values()].sort((a, b) => rank(a.category) - rank(b.category))
}
