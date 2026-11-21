// 様式の取り込み（#99）の精度を測る道具: AI の下書きを、手で作った版（template.json の schemas と bindings.json）と比べる。
// 試しの円の記録と予算の確かめもここ（費用のかかる試しは評価用のプロジェクトで流す）。
import { family, type DraftSlot, type Mark } from '../../../worker/form-import/draft.ts'

interface Ref { key: string, path?: unknown[] }
interface HandBinding { op: string, ui: string, ref: Ref, is?: { eq?: unknown, startsWith?: string, rowWhere?: Record<string, unknown>, [k: string]: unknown }, era?: string, [k: string]: unknown }
interface HandSchema { name: string, type: string, position: { x: number, y: number }, width: number, height: number }

function refText(r: Ref, rowField?: string): string {
  const path = r.path ?? []
  const listRow = path.some((p) => typeof p === 'object' || typeof p === 'number') || !!rowField
  const names = path.filter((p): p is string => typeof p === 'string')
  return [listRow ? `${r.key}[]` : r.key, ...names, ...(rowField ? [rowField] : [])].join('.')
}

/** 手の対応を catalog の書き方にする。家族のどの行か（flag）は比べない。行の種類で選ぶ印は、その行の欄まで書く */
export function handRef(b: HandBinding): string {
  const row = b.is?.rowWhere ? Object.keys(b.is.rowWhere)[0] : undefined
  return refText(b.ref, row)
}

/** 手の対応が使う key の全部（主の ref と、条件・直し方の中の ref）。AI がこのどれかを答えれば合っているとみなす */
export function handRefs(b: HandBinding): Set<string> {
  const out = new Set([handRef(b)])
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (o.ref && typeof (o.ref as Ref).key === 'string') out.add(refText(o.ref as Ref))
    for (const [k, x] of Object.entries(o)) if (k !== 'ref') walk(x)
  }
  walk({ ...b, ref: undefined })
  return out
}

const MARK = new Set(['check', 'circle', 'cell'])
/** 組にする条件: 同じ種類（印か文字か）で、AI の欄の中心が手の欄を 2mm 広げた枠に入る */
const PAD = 2

export interface Comparison {
  hand: number
  ai: number
  found: number
  extra: number
  refMatch: number
  optionMatch: number
  optionTotal: number
  /** 組になった欄で、左上のずれ（x・y の大きい方）がこの範囲に入った数 */
  within: { mm03: number, mm1: number, mm3: number }
  missed: string[]
  pairs: { hand: string, ai: number, dx: number, dy: number, refOk: boolean, handRef: string, aiRef: string | null }[]
}

export function compareDraft(ai: DraftSlot[], hand: { schemas: HandSchema[], bindings: Record<string, HandBinding> }): Comparison {
  const used = new Set<number>()
  const r: Comparison = { hand: hand.schemas.length, ai: ai.length, found: 0, extra: 0, refMatch: 0, optionMatch: 0, optionTotal: 0, within: { mm03: 0, mm1: 0, mm3: 0 }, missed: [], pairs: [] }
  for (const s of hand.schemas) {
    const b = hand.bindings[s.name]
    const ui = b?.ui ?? 'text'
    let best = -1
    let bestD = Infinity
    ai.forEach((a, i) => {
      // 記号を書くマス（cell）は、AI が文字の欄と答えても印と答えても組にする
      if (used.has(i) || (ui !== 'cell' && family(a.ui) !== family(ui))) return
      const cx = a.x + a.w / 2
      const cy = a.y + a.h / 2
      if (cx < s.position.x - PAD || cx > s.position.x + s.width + PAD || cy < s.position.y - PAD || cy > s.position.y + s.height + PAD) return
      const d = Math.hypot(a.x - s.position.x, a.y - s.position.y)
      if (d < bestD) { bestD = d; best = i }
    })
    if (best < 0) { r.missed.push(s.name); continue }
    used.add(best)
    r.found++
    const a = ai[best]
    const dx = a.x - s.position.x
    const dy = a.y - s.position.y
    const m = Math.max(Math.abs(dx), Math.abs(dy))
    if (m <= 0.3) r.within.mm03++
    if (m <= 1) r.within.mm1++
    if (m <= 3) r.within.mm3++
    const want = b ? handRef(b) : ''
    // 家族などの行を番号で答えたもの（[0]）も、行の欄（[]）として比べる。どの行かは手の版でも比べていない
    const aiRef = a.ref?.replace(/\[[^\]]*\]/g, '[]') ?? null
    const refOk = !!b && aiRef !== null && handRefs(b).has(aiRef)
    if (refOk) r.refMatch++
    const want2 = b && MARK.has(ui) ? handMark(b) : null
    if (want2) {
      r.optionTotal++
      if (refOk && a.mark && sameMark(a.mark, want2)) r.optionMatch++
    }
    r.pairs.push({ hand: s.name, ai: best, dx, dy, refOk, handRef: want, aiRef: a.ref })
  }
  r.extra = ai.length - used.size
  return r
}

const sameMark = (a: Mark, h: Mark) => a.kind === h.kind && (a.kind !== 'eq' || (h.kind === 'eq' && a.value.startsWith(h.value)))

/** 手の対応の条件（is・if）を、AI の答えと同じ形にする。形にできないものは null（比べない） */
export function handMark(b: HandBinding): Mark | null {
  const of = (is: Record<string, unknown> | undefined): Mark | null => {
    if (!is) return null
    if (is.eq === true) return { kind: 'true' }
    if (is.eq === false) return { kind: 'false' }
    if (typeof is.eq === 'string') return { kind: 'eq', value: is.eq }
    if (typeof is.startsWith === 'string') return { kind: 'eq', value: is.startsWith }
    if (is.rowWhere) return of(Object.values(is.rowWhere as Record<string, Record<string, unknown>>)[0])
    if (is.not && (is.not as Record<string, unknown>).in) return { kind: 'none' }
    if (is.nonEmpty) return { kind: 'nonEmpty' }
    if (is.empty) return { kind: 'empty' }
    return null
  }
  const own = of(b.is as Record<string, unknown> | undefined)
  if (own) return own
  // 「あり」「なし」のように、いくつかの key をまとめた条件（if）は、最初の条件の形で見る
  const cond = b.if as { any?: { is?: Record<string, unknown> }[], all?: { is?: Record<string, unknown> }[] } | undefined
  const first = cond?.any?.[0] ?? cond?.all?.[0]
  return first ? of(first.is) : null
}

/** 試しの記録（1 行 1 回の JSON、yen を持つ）から、使った円の合計 */
export function spentYen(ledger: string): number {
  return ledger.split('\n').filter((l) => l.trim()).reduce((sum, l) => sum + Number(JSON.parse(l).yen ?? 0), 0)
}

/** 使った円＋今回の見込みが予算を超えるなら止める */
export function checkBudget(spent: number, estimate: number, budget: number): void {
  if (spent + estimate > budget) throw new Error(`予算を超えるので流しません（使った ${spent.toFixed(0)} 円＋見込み ${estimate.toFixed(0)} 円 > 予算 ${budget} 円）`)
}
