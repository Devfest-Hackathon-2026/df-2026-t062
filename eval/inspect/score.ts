// AI 点検の採点。正解（eval/inspect/gold.json。Claude の叩き台）と AI の段階を比べる。
import type { Level } from '../../core/checks/index.ts'

export interface Ablation {
  id: string
  /** 消す欄 */
  remove?: string[]
  /** 値を替える・足す欄 */
  set?: Record<string, unknown>
  /** 項目ごとに、段階が下がる（lower）か上がる（higher）はず */
  expect: Record<string, 'lower' | 'higher'>
  why?: string
}

export interface Gold {
  note: string
  sheet: string
  checkSet: string
  levels: Record<string, { level: Level, sure: boolean, why: string }>
  ablations: Ablation[]
}

type Got = ReadonlyMap<string, Level | null>

/** 段階の一致と、要確認（1）かどうかの一致。sure の項目だけの一致も出す */
export function scoreLevels(gold: Gold['levels'], got: Got) {
  const ids = Object.keys(gold)
  const diff: { id: string, gold: Level, got: Level | null, sure: boolean }[] = []
  const missed: string[] = []
  const extra: string[] = []
  let exact = 0
  let agree = 0
  let sureTotal = 0
  let sureExact = 0
  for (const id of ids) {
    const g = gold[id]
    const a = got.get(id) ?? null
    const hit = a === g.level
    if (hit) exact++
    else diff.push({ id, gold: g.level, got: a, sure: g.sure })
    if (g.sure) {
      sureTotal++
      if (hit) sureExact++
    }
    const gNeed = g.level === '1'
    const aNeed = a === null ? !gNeed : a === '1'
    if (gNeed === aNeed) agree++
    else if (gNeed) missed.push(id)
    else extra.push(id)
  }
  return { total: ids.length, exact, needCheck: { agree, missed, extra }, sure: { total: sureTotal, exact: sureExact }, diff }
}

/** 欄を消した・替えた写し（元は変えない） */
export function applyAblation(values: Record<string, unknown>, a: Ablation): Record<string, unknown> {
  const out = { ...values }
  for (const k of a.remove ?? []) delete out[k]
  Object.assign(out, a.set ?? {})
  return out
}

/** 比べるための順位（他 は満たしている側なので 2 と同じ） */
const rank = (l: Level | null | undefined) => (l === '3' ? 3 : l === '2' || l === '他' ? 2 : l === '1' ? 1 : 0)

/** 欄を変えたときに、決めた向きに段階が動いたか */
export function scoreAblation(a: Ablation, before: Got, after: Got) {
  return Object.entries(a.expect).map(([id, expect]) => {
    const b = before.get(id) ?? null
    const f = after.get(id) ?? null
    return { id, expect, before: b, after: f, ok: expect === 'lower' ? rank(f) < rank(b) : rank(f) > rank(b) }
  })
}
