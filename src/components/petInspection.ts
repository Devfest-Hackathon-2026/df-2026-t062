// 点検の画面の決まり（文言・これまでの点検・レーダーの形）。決定版: https://claude.ai/artifact/La1RqwX2TgoBN8eyRtfyPi
import type { CategoryCount } from '../../core/checks/index.ts'
import type { InspectionItem, InspectionSummary, InspectionView } from '../../db/inspections.ts'

export type { InspectionItem, InspectionSummary, InspectionView }

const JST = 9 * 3600 * 1000
const jst = (iso: string) => new Date(new Date(iso).getTime() + JST)

/** 日本の時刻で「11/20 14:05」 */
export function fmtWhen(iso: string): string {
  const d = jst(iso)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

const done = (s: InspectionSummary) => s.status === 'succeeded' || s.status === 'partial'
export const running = (s: InspectionSummary) => s.status === 'queued' || s.status === 'processing'

export type Tone = 'none' | 'ng' | 'ok'
/** メニューの「点検する」の小さい字。読み込む前は null */
export function menuStatus(list: InspectionSummary[] | undefined): { text: string, tone: Tone } | null {
  if (!list) return null
  if (list[0] && running(list[0])) return { text: '（点検しています…）', tone: 'none' }
  const last = list.find(done)
  if (!last) return { text: '（まだ点検していません）', tone: 'none' }
  return last.missingCount ? { text: `（要確認 ${last.missingCount}件）`, tone: 'ng' } : { text: '（適合）', tone: 'ok' }
}

/** 猫の言葉。pill があれば、評価の札をはさむ */
export function catMessage(v: InspectionView): { before: string, pill?: '要確認' | '適合', after?: string } {
  if (v.latest && v.changed) return { before: `前の点検（${fmtWhen(v.createdAt)}）のあとに、用紙が変わっています。もう一度点検しますか？` }
  const ng = v.missingCount > 0
  if (!v.latest) {
    return ng
      ? { before: 'このときの結果は', pill: '要確認', after: `でした。${v.total} 項目のうち ${v.missingCount} 項目で、情報が足りませんでした。` }
      : { before: 'このときの結果は', pill: '適合', after: 'でした。確認が必要なところはありませんでした。' }
  }
  return ng
    ? { before: '点検の結果は', pill: '要確認', after: `です。${v.total} 項目のうち ${v.missingCount} 項目で、情報が足りません。` }
    : { before: '点検の結果は', pill: '適合', after: 'です。確認が必要なところはありません。' }
}

/** 項目の下の言葉（満たしている項目は null で、✓ だけ） */
export function itemNote(i: InspectionItem): string | null {
  if (i.level === null) return '判定できませんでした'
  if (i.level !== '1') return null
  return `${i.missing ?? ''}${i.fieldKey ? '' : '・用紙に欄なし'}`
}

export interface HistoryRow { id: string, createdAt: string, when: string, by: string | null, label: string, tone: Tone, diff: string | null, current: boolean }

/** これまでの点検（終わったものだけ、新しい順）。差は 1 つ前の終わった点検と比べる */
export function historyRows(list: InspectionSummary[], currentId: string | null): HistoryRow[] {
  const rows = list.filter(done)
  return rows.map((s, i) => {
    const prev = rows[i + 1]
    const d = prev ? s.missingCount - prev.missingCount : null
    return {
      id: s.id, createdAt: s.createdAt, when: fmtWhen(s.createdAt), by: s.createdBy,
      label: s.missingCount ? `要確認 ${s.missingCount}` : '適合', tone: s.missingCount ? 'ng' : 'ok',
      diff: d === null ? null : d < 0 ? `前回より ${-d} 減` : d > 0 ? `前回より ${d} 増` : '前回と同じ',
      current: s.id === currentId,
    }
  })
}

/** 「すべて見る」: 日本の月ごと */
export function monthGroups(rows: HistoryRow[]): { month: string, rows: HistoryRow[] }[] {
  const out: { month: string, rows: HistoryRow[] }[] = []
  for (const r of rows) {
    const d = jst(r.createdAt)
    const month = `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`
    const g = out.at(-1)
    if (g?.month === month) g.rows.push(r)
    else out.push({ month, rows: [r] })
  }
  return out
}

// ---------- レーダー（決定版の形: viewBox 340×262、中心 170,140、半径 72） ----------

const CX = 170
const CY = 140
const R = 72
const round = (n: number) => Math.round(n * 100) / 100
const at = (i: number, n: number, r: number) => {
  const a = (-90 + (360 / n) * i) * Math.PI / 180
  return { x: round(CX + r * Math.cos(a)), y: round(CY + r * Math.sin(a)) }
}

/** 名前の折り返し（決定版のとおり） */
const LINES: Record<string, string[]> = {
  '疾病・心身状態の把握': ['疾病・心身', '状態の把握'],
  '主訴・意思の把握・尊重': ['主訴・意思の', '把握・尊重'],
  '家族の状況の把握と支援': ['家族の状況の', '把握と支援'],
  '課題を解決するためのサービス計画': ['サービス計画'],
}
/** 5 つのときの名前の場所（決定版のとおり）。ほかの数のときは軸の先に置く */
const PLACE5: { x: number, y: number, anchor: 'start' | 'middle' | 'end' }[] = [
  { x: 170, y: 40, anchor: 'middle' }, { x: 250, y: 102, anchor: 'start' }, { x: 220, y: 216, anchor: 'start' },
  { x: 120, y: 216, anchor: 'end' }, { x: 90, y: 102, anchor: 'end' },
]

export function radar(cats: CategoryCount[]) {
  const n = cats.length
  const axes = cats.map((_, i) => at(i, n, R))
  const rings = [R, R * 0.75, R * 0.5, R * 0.25].map((r) => cats.map((_, i) => at(i, n, r)))
  const points = cats.map((c, i) => ({ ...at(i, n, c.total ? (R * c.satisfied) / c.total : 0), ng: c.satisfied < c.total }))
  const labels = cats.map((c, i) => {
    const p = n === 5 ? PLACE5[i] : (() => {
      const q = at(i, n, R + 24)
      return { ...q, anchor: (Math.abs(q.x - CX) < 4 ? 'middle' : q.x > CX ? 'start' : 'end') as 'start' | 'middle' | 'end' }
    })()
    return { lines: LINES[c.category] ?? [c.category], value: `${c.satisfied} / ${c.total}`, ng: c.satisfied < c.total, ...p }
  })
  return { axes, rings, points, labels, center: { x: CX, y: CY }, label: `観点ごとの満たしている割合。${cats.map((c) => `${c.category} ${c.satisfied}/${c.total}`).join('、')}` }
}
