// 様式の取り込み（#99）: 位置の候補（表のマスと □）を、PDF から取り出した罫線と文字から見つける。AI は呼ばない。
// 単位は mm、ページの左上が原点（worker/form-import/pdf.ts の LayoutPage）。
// AI にはマスと □ に番号を付けて渡し、番号で答えた欄は、ここで正確な位置に置き直す。
import type { DraftSlot } from './draft.ts'
import type { LayoutPage } from './pdf.ts'

/** 表のマス、または □。番号は 1 から */
export interface Cell { id: number, x: number, y: number, w: number, h: number }

const TOL = 0.5 // 同じ線とみなすずれ（mm）
const MIN_CELL = 3 // これより小さい四角は □ などなのでマスにしない
const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * 表の線の位置。近い位置（TOL 以内）の線をまとめ、長さの合計が MIN_CELL 未満のまとまりは捨てる（文字を線で描いた短い断片など）。
 * 点線のように短い線が並ぶ罫線は、合計が長いので残る。位置は、まとまりの中でいちばん長い線の位置
 */
function levels(lines: [number, number, number][]): number[] {
  const sorted = [...lines].sort((a, b) => a[0] - b[0])
  const groups: [number, number, number][][] = []
  for (const l of sorted) {
    const g = groups.at(-1)
    if (g && l[0] - g[g.length - 1][0] <= TOL) g.push(l)
    else groups.push([l])
  }
  return groups
    .filter((g) => g.reduce((sum, [, a, b]) => sum + (b - a), 0) >= MIN_CELL)
    .map((g) => g.reduce((best, l) => (l[2] - l[1] > best[2] - best[1] ? l : best))[0])
}

/** ある位置の線が、a から b までを途切れずに覆っているか（線が何本かに分かれていてもつなぐ） */
function covers(lines: [number, number, number][], at: number, a: number, b: number): boolean {
  const segs = lines.filter(([p]) => Math.abs(p - at) <= TOL).map(([, s, e]) => [s, e]).sort((m, n) => m[0] - n[0])
  let reach = a
  for (const [s, e] of segs) {
    if (s > reach + TOL) break
    reach = Math.max(reach, e)
    if (reach >= b - TOL) return true
  }
  return false
}

/** 罫線で四方を囲まれた表のマスを見つける。中の線が途切れた所は 1 つのマスにまとめる（結合したマス） */
export function findCells(p: Pick<LayoutPage, 'hlines' | 'vlines'>): Cell[] {
  const ys = levels(p.hlines)
  const xs = levels(p.vlines)
  const R = ys.length - 1
  const C = xs.length - 1
  if (R < 1 || C < 1) return []
  const top = (i: number, j: number) => covers(p.hlines, ys[i], xs[j], xs[j + 1])
  const left = (i: number, j: number) => covers(p.vlines, xs[j], ys[i], ys[i + 1])
  const seen = new Set<number>()
  const out: Omit<Cell, 'id'>[] = []
  for (let i0 = 0; i0 < R; i0++) {
    for (let j0 = 0; j0 < C; j0++) {
      if (seen.has(i0 * C + j0)) continue
      // 線のない辺を通ってつながる小さいマスを集める。表の外に出たらマスではない
      const stack = [[i0, j0]]
      const region: number[][] = []
      let open = false
      seen.add(i0 * C + j0)
      while (stack.length) {
        const [i, j] = stack.pop()!
        region.push([i, j])
        const next: [number, number, boolean][] = [
          [i - 1, j, top(i, j)], [i + 1, j, top(i + 1, j)], [i, j - 1, left(i, j)], [i, j + 1, left(i, j + 1)],
        ]
        for (const [ni, nj, wall] of next) {
          if (wall) continue
          if (ni < 0 || nj < 0 || ni >= R || nj >= C) { open = true; continue }
          if (!seen.has(ni * C + nj)) { seen.add(ni * C + nj); stack.push([ni, nj]) }
        }
      }
      if (open) continue
      const i1 = Math.min(...region.map(([i]) => i))
      const i2 = Math.max(...region.map(([i]) => i))
      const j1 = Math.min(...region.map(([, j]) => j))
      const j2 = Math.max(...region.map(([, j]) => j))
      if (region.length !== (i2 - i1 + 1) * (j2 - j1 + 1)) continue // 四角でない
      const cell = { x: r2(xs[j1]), y: r2(ys[i1]), w: r2(xs[j2 + 1] - xs[j1]), h: r2(ys[i2 + 1] - ys[i1]) }
      if (cell.w >= MIN_CELL && cell.h >= MIN_CELL) out.push(cell)
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x).map((c, k) => ({ id: k + 1, ...c }))
}

const INSET = 0.8

/** マスの番号で答えた欄を、マスの内側に置き直す */
export function placeInCells(slots: DraftSlot[], cells: Cell[]): DraftSlot[] {
  const byId = new Map(cells.map((c) => [c.id, c]))
  return slots.map((s) => {
    const c = s.cell !== undefined ? byId.get(s.cell) : undefined
    return c ? { ...s, x: r2(c.x + INSET), y: r2(c.y + INSET), w: r2(c.w - 2 * INSET), h: r2(c.h - 2 * INSET) } : s
  })
}

// □ とみなす大きさ。紙の書類の □ は、小さいもので 2mm 前後、大きいもので 5mm 前後。少し広めに取る
const BOX_MIN = 1.5
const BOX_MAX = 6.5
const BOX_GLYPHS = new Set(['□', '☐', '▢', '◻', '⬜', '❏', '❑'])

interface Char { t: string, x0: number, y0: number, x1: number, y1: number, ink?: number[] | null }

/** □ を見つける。「□」などの文字（インクの範囲があればそれ）と、線で描いた小さな正方形の両方。中心が近いものは 1 つにする */
export function findBoxes(p: { chars?: Char[], hlines: [number, number, number][], vlines: [number, number, number][] }): Cell[] {
  const found: Omit<Cell, 'id'>[] = []
  const sizeOk = (w: number, h: number) => w >= BOX_MIN && w <= BOX_MAX && h >= BOX_MIN && h <= BOX_MAX && Math.abs(w - h) <= 1
  for (const c of p.chars ?? []) {
    if (!BOX_GLYPHS.has(c.t)) continue
    const [x0, y0, x1, y1] = c.ink && c.ink.length === 4 ? c.ink : [c.x0, c.y0, c.x1, c.y1]
    if (sizeOk(x1 - x0, y1 - y0)) found.push({ x: r2(x0), y: r2(y0), w: r2(x1 - x0), h: r2(y1 - y0) })
  }
  const short = p.hlines.filter(([, a, b]) => b - a >= BOX_MIN && b - a <= BOX_MAX)
  for (const [y1, a1, b1] of short) {
    for (const [y2, a2, b2] of short) {
      const h = y2 - y1
      if (h < BOX_MIN || Math.abs(a1 - a2) > TOL || Math.abs(b1 - b2) > TOL || !sizeOk(b1 - a1, h)) continue
      if (covers(p.vlines, a1, y1, y2) && covers(p.vlines, b1, y1, y2)) found.push({ x: r2(a1), y: r2(y1), w: r2(b1 - a1), h: r2(h) })
    }
  }
  const out: Omit<Cell, 'id'>[] = []
  const center = (b: Omit<Cell, 'id'>) => [b.x + b.w / 2, b.y + b.h / 2]
  for (const b of found) {
    const [cx, cy] = center(b)
    if (!out.some((o) => { const [ox, oy] = center(o); return Math.abs(ox - cx) <= 0.8 && Math.abs(oy - cy) <= 0.8 })) out.push(b)
  }
  return out.sort((a, b) => Math.round(a.y) - Math.round(b.y) || a.x - b.x).map((b, k) => ({ id: k + 1, ...b }))
}

/** □ の番号で答えた欄を、□ の位置に置き直す */
export function placeInBoxes(slots: DraftSlot[], boxes: Cell[]): DraftSlot[] {
  const byId = new Map(boxes.map((b) => [b.id, b]))
  return slots.map((s) => {
    const b = s.box !== undefined ? byId.get(s.box) : undefined
    return b ? { ...s, x: b.x, y: b.y, w: b.w, h: b.h } : s
  })
}

/** どの印の欄（✓・丸）にも使われていない □ */
export function unusedBoxes(slots: DraftSlot[], boxes: Cell[]): Cell[] {
  const marks = slots.filter((s) => s.ui === 'check' || s.ui === 'circle')
  return boxes.filter((b) => !marks.some((s) => {
    const cx = s.x + s.w / 2
    const cy = s.y + s.h / 2
    return cx >= b.x - 1 && cx <= b.x + b.w + 1 && cy >= b.y - 1 && cy <= b.y + b.h + 1
  }))
}

