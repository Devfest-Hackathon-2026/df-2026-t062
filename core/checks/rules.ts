// 点検のうち、プログラムで判定する観点（docs/再設計/16_書類と点検の基盤.md の「流れ」の 2）。
// 物差しの method が rule・both の項目に関数がある。
//   段階（level）を返したら、その項目は AI に聞かない。
//   観点の当否（met）だけを返したら、段階は AI が決める（AI にはその当否を渡す）。
//   null なら決めない（AI に任せる）。rule の項目は必ず段階を返す。
import type { Level } from './index.ts'

export interface RuleInput {
  /** 読んだ書類の値（欄の key → 値） */
  values: Record<string, unknown>
  /** 読んだ書類の値を「欄の名前: 値」にした文（特記などの文章も含む） */
  text: string
}
export type RuleResult = { level: Level, missing?: string } | { met: Record<string, boolean> } | null
export type Rule = (input: RuleInput) => RuleResult

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(isEmpty))

/** 13 BMI: 数字が書いてあるか。身長・体重だけでは 1（出典の注） */
const bmi: Rule = ({ text }) => (/BMI\s*(?:[:=]|は|が)?\s*\d+(?:\.\d+)?/i.test(text.normalize('NFKC'))
  ? { level: '2' }
  : { level: '1', missing: 'BMI の数字が書かれていない' })

/** 31 家族関係や周辺の社会資源: 家族構成図がなければ 1。あれば、エコマップの有無は AI が図を読んで決める */
const genogram: Rule = ({ values }) => (isEmpty(values['family.genogram']) ? { level: '1', missing: '家族構成図がない' } : null)

// ---------- 期間 ----------

const ERA: Record<string, number> = { 令和: 2018, R: 2018, 平成: 1988, H: 1988 }
const DATE = /(令和|平成|R|H)?\s*(\d{1,4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?/gi

/** 文の中の日付（西暦・令和・平成）を、出てきた順に YYYY-MM-DD にする */
function datesIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.normalize('NFKC').matchAll(DATE)) {
    const era = m[1] ? ERA[m[1].toUpperCase() === 'R' ? 'R' : m[1].toUpperCase() === 'H' ? 'H' : m[1]] : 0
    const y = era ? era + Number(m[2]) : Number(m[2])
    if (y < 1900) continue
    out.push(`${y}-${m[3].padStart(2, '0')}-${m[4].padStart(2, '0')}`)
  }
  return out
}

/** 期間の文（例「2026/1/1〜2026/6/30」「令和8年1月1日～令和8年12月31日」）が、開始日・終了日とも有効期間の中か。日付が 2 つ読めなければ null */
export function withinPeriod(period: string, cert: { from: string, to: string }): boolean | null {
  const ds = datesIn(period)
  if (ds.length < 2) return null
  const [start, end] = [ds[0], ds[ds.length - 1]]
  const valid=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v
  if(![start,end,cert.from,cert.to].every(valid)||cert.from>cert.to)return null
  return start<=end&&start >= cert.from && end <= cert.to
}

/** 37 長期目標の ③: 長期目標の期間は、開始日・終了日とも認定の有効期間の中か（どれか 1 つでも外なら当たらない） */
const longGoalPeriod: Rule = ({ values }) => {
  const from = values['cert.validFrom']
  const to = values['cert.validTo']
  const needs = values['plan.needs']
  if (typeof from !== 'string' || typeof to !== 'string' || !Array.isArray(needs)) return null
  const rs = needs.map((n) => (typeof n?.longGoalPeriod === 'string' ? withinPeriod(n.longGoalPeriod, { from, to }) : null))
  if (!rs.length || (!rs.includes(false)&&rs.includes(null))) return null
  return { met: { '③': rs.every(Boolean) } }
}

export const RULES: Record<string, Rule> = { 13: bmi, 31: genogram, 37: longGoalPeriod }
