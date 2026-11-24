// 様式の取り込み（#99）: PDF から文字・語・罫線の座標を取り出し、ページを画像にする。Node.js だけで動く（pdfjs-dist と @napi-rs/canvas）。
//
// 出す形は、様式を作る道具の forms/tools/scripts/extract_layout.py（Python の pdfplumber）の layout.json と同じ。
// 単位は mm、各ページの左上（表示範囲）が原点。決め方も pdfplumber に合わせる:
//   文字 … 1 文字の枠。横は送り幅、縦は「基準線＋フォントの descent」から文字の大きさ分（pdfminer と同じ）
//   語   … 同じ行（上端の差が 3pt 以内）で、間が 1.5pt 以内の文字をつなぐ。空白で切る
//   罫線 … 塗る・線を引く図形の、水平・垂直の辺（四角の辺も含む）。切り抜きだけの図形は入れない
//   ink  … ページを 300dpi の画像にして、文字の枠の中で暗い画素がある範囲（ink: true のときだけ）
// 文字の位置の計算は、pdfjs の描画（CanvasGraphics の showText）と同じ規則で行う。
// 実物の様式で Python の取り出しと一致するかは forms/tools/import/verify-layout.ts で確かめる。
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

export interface LayoutWord { t: string, x0: number, y0: number, x1: number, y1: number }
export interface LayoutChar extends LayoutWord {
  /** 基準線の高さ（mm） */
  b: number
  /** 文字の大きさ（mm） */
  s: number
  /** インクの範囲 [x0, y0, x1, y1]（mm）。測らなかった・測れなかったら null */
  ink: number[] | null
}
export interface LayoutPage {
  page: number
  width: number
  height: number
  words: LayoutWord[]
  chars: LayoutChar[]
  /** [y, x0, x1] */
  hlines: [number, number, number][]
  /** [x, y0, y1] */
  vlines: [number, number, number][]
}

export interface OpenedPdf {
  numPages: number
  layout(page: number, opts?: { ink?: boolean }): Promise<LayoutPage>
  /** ページの画像（PNG）。表示範囲だけを描く */
  png(page: number, dpi: number): Promise<Buffer>
  /** ページを描いた上に、さらに描いて PNG にする（見直し用の画像）。px は mm を画素にする関数 */
  draw(page: number, dpi: number, paint: (ctx: SKRSContext2D, px: (mm: number) => number) => void): Promise<Buffer>
  /** 添付ファイルかスクリプト（JavaScript）が入っているか。入っていれば取り込まない */
  risky(): Promise<boolean>
  close(): Promise<void>
}

const PT = 25.4 / 72
const r2 = (v: number) => Math.round(v * PT * 100) / 100
const INK_DPI = 300
const INK_THRESHOLD = 150

const pdfjsDir = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))

type M = [number, number, number, number, number, number]
const ID: M = [1, 0, 0, 1, 0, 0]
/** a ∘ b（b を当ててから a を当てる） */
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
]
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

interface FontObj { vertical?: boolean, descent?: number, fontMatrix?: number[], defaultVMetrics?: number[], isType3Font?: boolean }
interface Glyph { unicode: string, width: number, isSpace: boolean, vmetric?: number[] }

interface State {
  ctm: M
  font: FontObj | null
  fontSize: number
  fontDirection: number
  fontMatrix: number[]
  charSpacing: number
  wordSpacing: number
  hScale: number
  leading: number
  rise: number
  textMatrix: M
  x: number
  y: number
  lineX: number
  lineY: number
}

const newState = (): State => ({
  ctm: ID, font: null, fontSize: 0, fontDirection: 1, fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
  charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, textMatrix: ID, x: 0, y: 0, lineX: 0, lineY: 0,
})

/** 取り出しの途中の 1 文字（PDF の座標。空白も持つ） */
interface RawChar { t: string, x0: number, top: number, x1: number, bottom: number, baseTop: number, size: number, upright: boolean }

export async function openPdf(data: Uint8Array): Promise<OpenedPdf> {
  const task = getDocument({
    data: new Uint8Array(data),
    cMapUrl: join(pdfjsDir, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: join(pdfjsDir, 'standard_fonts') + '/',
    wasmUrl: join(pdfjsDir, 'wasm') + '/',
    // 演算子・文字の復号失敗も部分成功として扱わない。
    stopAtErrors: true,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  })
  const doc = await task.promise

  async function render(pageNo: number, dpi: number) {
    const page = await doc.getPage(pageNo)
    const viewport = page.getViewport({ scale: dpi / 72 })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise
    // PDF.jsは画像だけの復号失敗をnullとして描画を続けることがある。
    // 白紙に見える原本を読取へ渡さず、画像XObjectの欠落をエラーにする。
    const operators = await page.getOperatorList()
    for (let index = 0; index < operators.fnArray.length; index++) {
      if (operators.fnArray[index] !== OPS.paintImageXObject && operators.fnArray[index] !== OPS.paintImageXObjectRepeat) continue
      const id = operators.argsArray[index]?.[0]
      if (typeof id !== 'string') continue
      const objects = id.startsWith('g_') ? page.commonObjs : page.objs
      if (!objects.has(id) || !objects.get(id)) throw new Error('pdf_image_decode_failed')
    }
    return canvas
  }

  async function layout(pageNo: number, opts: { ink?: boolean } = {}): Promise<LayoutPage> {
    const page = await doc.getPage(pageNo)
    const [vx0, vy0, vx1, vy1] = page.view
    const ol = await page.getOperatorList()
    const raw: RawChar[] = []
    const hl: [number, number, number][] = []
    const vl: [number, number, number][] = []
    const stack: State[] = []
    let st = newState()
    const formStack: M[] = []

    // PDF の座標（下が 0）→ ページの上端から（pt）
    const toTop = (y: number) => vy1 - y
    const inView = (x: number, y: number) => x >= vx0 - 0.5 && x <= vx1 + 0.5 && y >= vy0 - 0.5 && y <= vy1 + 0.5

    // 水平・垂直の線。紙の上で見えない傾き（SKEW pt まで）は水平・垂直とみなし、位置は両端の平均にする
    // （pdfplumber は傾いた線も縦の線として数える。表の枠を 0.01pt だけ傾けて描く PDF がある）
    const SKEW = 0.1
    const addSegment = (ax: number, ay: number, bx: number, by: number) => {
      const dx = Math.abs(ax - bx)
      const dy = Math.abs(ay - by)
      if (dy <= SKEW && dx > SKEW) {
        const y = (ay + by) / 2
        if (y < vy0 - 0.5 || y > vy1 + 0.5) return
        const x0 = Math.max(Math.min(ax, bx), vx0)
        const x1 = Math.min(Math.max(ax, bx), vx1)
        if (x1 > x0) hl.push([toTop(y), x0 - vx0, x1 - vx0])
      } else if (dx <= SKEW && dy > SKEW) {
        const x = (ax + bx) / 2
        if (x < vx0 - 0.5 || x > vx1 + 0.5) return
        const yTop = Math.max(Math.min(ay, by), vy0)
        const yBottom = Math.min(Math.max(ay, by), vy1)
        if (yBottom > yTop) vl.push([x - vx0, toTop(yBottom), toTop(yTop)])
      }
    }

    // 細い画像は線とみなす。点線を、短い画像を並べて描く PDF がある（厚生労働省のケアプラン第 3 表は 2mm×0.25mm の画像を並べる。#147）。
    // 画像は 1×1 の正方形を m で置いたもの。厚さが THIN_IMAGE pt 以下で、長さが厚さの 3 倍以上なら、真ん中を通る線にする
    const THIN_IMAGE = 0.6 / PT
    const addImage = (m: M) => {
      const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)]
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      const w = x1 - x0
      const h = y1 - y0
      if (h <= THIN_IMAGE && w >= 3 * h) addSegment(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2)
      else if (w <= THIN_IMAGE && h >= 3 * w) addSegment((x0 + x1) / 2, y0, (x0 + x1) / 2, y1)
    }

    const showText = (glyphs: (Glyph | number)[]) => {
      const font = st.font
      const fs = st.fontSize
      if (!font || fs === 0 || font.isType3Font) return
      const was = fs * st.fontMatrix[0]
      const hs = st.hScale * st.fontDirection
      const vertical = !!font.vertical
      const spacingDir = vertical ? 1 : -1
      const descent = font.descent ?? 0
      // 文字の空間（Tm の前）→ ページ
      const m = mul(st.ctm, st.textMatrix)
      let x = 0
      for (const g of glyphs) {
        if (typeof g === 'number') { x += spacingDir * g * fs / 1000; continue }
        const spacing = (g.isSpace ? st.wordSpacing : 0) + st.charSpacing
        let width = g.width
        let gx: number
        let gy: number
        const hAdvance = g.width * was
        if (vertical) {
          const vmetric = g.vmetric || font.defaultVMetrics
          const vx = -(g.vmetric ? vmetric![1] : width * 0.5) * was
          const vy = (vmetric ? vmetric[2] : 0) * was
          width = vmetric ? -vmetric[0] : width
          gx = vx
          gy = x + vy
        } else {
          gx = x
          gy = 0
        }
        // 描画では translate(x, y + rise) と scale(hs, -1) をしてから (gx, gy) に描く。上向きの y に直す
        const ox = st.x + hs * gx
        const oy = st.y + st.rise - gy
        // 文字の枠の下端（上向きの y）。横書きは基準線＋descent。縦書きは描く位置から 1 文字分上まで（pdfminer と同じ）
        const low = vertical ? oy : oy + descent * fs
        const corners = [
          apply(m, ox, low), apply(m, ox + hs * hAdvance, low),
          apply(m, ox, low + fs), apply(m, ox + hs * hAdvance, low + fs),
        ]
        const xs = corners.map((c) => c[0])
        const ys = corners.map((c) => c[1])
        // 基準線は、その文字を描く前のペンの位置（pdfminer の文字の行列の位置と同じ。縦書きでは vy でずらす前）
        const base = apply(m, ox, vertical ? st.y + st.rise - x : oy)
        const lowPt = apply(m, ox, low)
        const up = apply(m, ox, low + fs)
        const size = Math.hypot(up[0] - lowPt[0], up[1] - lowPt[1])
        const upright = Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2
        if (g.unicode && inView(cx, cy)) {
          raw.push({
            t: g.unicode, x0: Math.min(...xs) - vx0, x1: Math.max(...xs) - vx0,
            top: toTop(Math.max(...ys)), bottom: toTop(Math.min(...ys)), baseTop: toTop(base[1]), size, upright,
          })
        }
        x += vertical ? width * was - spacing * st.fontDirection : width * was + spacing * st.fontDirection
      }
      if (vertical) st.y -= x
      else st.x += x * hs
    }

    const PAINT = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i]
      const args = ol.argsArray[i] as unknown[]
      switch (fn) {
        case OPS.save: stack.push({ ...st }); break
        case OPS.restore: st = stack.pop() ?? st; break
        case OPS.transform: st.ctm = mul(st.ctm, args as M); break
        case OPS.paintFormXObjectBegin: formStack.push(st.ctm); if (args[0]) st.ctm = mul(st.ctm, args[0] as M); break
        case OPS.paintFormXObjectEnd: st.ctm = formStack.pop() ?? st.ctm; break
        case OPS.beginText: st.textMatrix = ID; st.x = st.lineX = 0; st.y = st.lineY = 0; break
        case OPS.setCharSpacing: st.charSpacing = args[0] as number; break
        case OPS.setWordSpacing: st.wordSpacing = args[0] as number; break
        case OPS.setHScale: st.hScale = (args[0] as number) / 100; break
        case OPS.setLeading: st.leading = -(args[0] as number); break
        case OPS.setTextRise: st.rise = args[0] as number; break
        case OPS.setFont: {
          const font = page.commonObjs.get(args[0] as string) as FontObj
          let size = args[1] as number
          st.fontDirection = 1
          if (size < 0) { size = -size; st.fontDirection = -1 }
          st.font = font
          st.fontSize = size
          st.fontMatrix = font?.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0]
          break
        }
        case OPS.moveText: st.x = st.lineX += args[0] as number; st.y = st.lineY += args[1] as number; break
        case OPS.setLeadingMoveText:
          st.leading = args[1] as number
          st.x = st.lineX += args[0] as number; st.y = st.lineY += args[1] as number
          break
        case OPS.setTextMatrix: st.textMatrix = args[0] as M; st.x = st.lineX = 0; st.y = st.lineY = 0; break
        case OPS.nextLine: st.x = st.lineX += 0; st.y = st.lineY += st.leading; break
        case OPS.showText: showText(args[0] as (Glyph | number)[]); break
        case OPS.paintImageXObject:
        case OPS.paintInlineImageXObject:
        case OPS.paintImageMaskXObject:
          addImage(st.ctm)
          break
        case OPS.paintImageXObjectRepeat: {
          // 同じ画像を何度も置く命令（pdfjs がまとめる）。引数は [画像, 横の倍率, 縦の倍率, 置く位置の x・y の並び]
          const [, sx, sy, positions] = args as [unknown, number, number, ArrayLike<number>]
          for (let k = 0; k + 1 < positions.length; k += 2) addImage(mul(st.ctm, [sx, 0, 0, sy, positions[k], positions[k + 1]]))
          break
        }
        case OPS.constructPath: {
          const [op, [data]] = args as [number, [ArrayLike<number> | null]]
          if (!PAINT.has(op) || !data) break
          let cx = 0, cy = 0, sx = 0, sy = 0
          for (let k = 0; k < data.length;) {
            const d = data[k++]
            if (d === 0) { [cx, cy] = apply(st.ctm, data[k], data[k + 1]); sx = cx; sy = cy; k += 2 }
            else if (d === 1) { const [nx, ny] = apply(st.ctm, data[k], data[k + 1]); addSegment(cx, cy, nx, ny); cx = nx; cy = ny; k += 2 }
            else if (d === 2 || d === 3) {
              // 曲線の命令でも、端点と制御点がすべて同じ横線・縦線の上にあれば直線（直線を曲線の命令で描く PDF がある）
              const n = d === 2 ? 3 : 2
              const pts = Array.from({ length: n }, (_, j) => apply(st.ctm, data[k + 2 * j], data[k + 2 * j + 1]))
              const [ex, ey] = pts[n - 1]
              const all = [[cx, cy], ...pts]
              if (all.every(([, y]) => Math.abs(y - cy) <= SKEW) || all.every(([x]) => Math.abs(x - cx) <= SKEW)) addSegment(cx, cy, ex, ey)
              cx = ex
              cy = ey
              k += 2 * n
            }
            else if (d === 4) { addSegment(cx, cy, sx, sy); cx = sx; cy = sy }
            else break
          }
          break
        }
      }
    }

    const chars: LayoutChar[] = []
    let mask: { data: Uint8ClampedArray, w: number, h: number } | null = null
    if (opts.ink) {
      const canvas = await render(pageNo, INK_DPI)
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
      mask = { data: img.data, w: canvas.width, h: canvas.height }
    }
    for (const c of raw) {
      if (!c.t.trim()) continue
      const ch: LayoutChar = { t: c.t, x0: r2(c.x0), y0: r2(c.top), x1: r2(c.x1), y1: r2(c.bottom), b: r2(c.baseTop), s: r2(c.size), ink: null }
      if (mask) ch.ink = charInk(mask, ch)
      chars.push(ch)
    }
    return {
      page: pageNo,
      width: r2(vx1 - vx0),
      height: r2(vy1 - vy0),
      words: extractWords(raw),
      chars,
      hlines: hl.map(([y, a, b]) => [r2(y), r2(a), r2(b)] as [number, number, number]).sort(cmp),
      vlines: vl.map(([x, a, b]) => [r2(x), r2(a), r2(b)] as [number, number, number]).sort(cmp),
    }
  }

  return {
    numPages: doc.numPages,
    layout,
    async png(pageNo, dpi) { return (await render(pageNo, dpi)).toBuffer('image/png') },
    async draw(pageNo, dpi, paint) {
      const canvas = await render(pageNo, dpi)
      paint(canvas.getContext('2d'), (mm) => mm / 25.4 * dpi)
      return canvas.toBuffer('image/png')
    },
    async risky() {
      const attachments = await doc.getAttachments()
      if (attachments && (attachments instanceof Map ? attachments.size : Object.keys(attachments).length)) return true
      // 文書のスクリプト（名前つきのスクリプトと、開いたときに動くスクリプト）
      const js = await doc.getJSActions()
      return !!js && (js instanceof Map ? js.size : Object.keys(js).length) > 0
    },
    async close() { await task.destroy() },
  }
}

const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

const X_TOL = 1.5
const Y_TOL = 3

/** pdfplumber の extract_words(x_tolerance=1.5, keep_blank_chars=False) と同じ考え方で語にする */
export function extractWords(raw: RawChar[]): LayoutWord[] {
  const out: LayoutWord[] = []
  const emit = (cs: RawChar[]) => {
    if (!cs.length) return
    out.push({
      t: cs.map((c) => c.t).join(''),
      x0: r2(Math.min(...cs.map((c) => c.x0))), y0: r2(Math.min(...cs.map((c) => c.top))),
      x1: r2(Math.max(...cs.map((c) => c.x1))), y1: r2(Math.max(...cs.map((c) => c.bottom))),
    })
  }
  const upright = raw.filter((c) => c.upright)
  const rotated = raw.filter((c) => !c.upright)
  // 横の行: 上端が近い文字をまとめ、左から並べ、間が空くか空白で切る
  for (const line of cluster(upright, (c) => c.top, Y_TOL)) {
    line.sort((a, b) => a.x0 - b.x0)
    let cur: RawChar[] = []
    for (const c of line) {
      if (!c.t.trim()) { emit(cur); cur = []; continue }
      const prev = cur.at(-1)
      if (prev && (c.x0 > prev.x1 + X_TOL || c.x1 < prev.x0 - X_TOL)) { emit(cur); cur = [] }
      cur.push(c)
    }
    emit(cur)
  }
  // 回した文字（縦の列）: 左端が近い文字をまとめ、上から並べる
  for (const col of cluster(rotated, (c) => c.x0, X_TOL)) {
    col.sort((a, b) => a.top - b.top)
    let cur: RawChar[] = []
    for (const c of col) {
      if (!c.t.trim()) { emit(cur); cur = []; continue }
      const prev = cur.at(-1)
      if (prev && c.top > prev.bottom + Y_TOL) { emit(cur); cur = [] }
      cur.push(c)
    }
    emit(cur)
  }
  return out
}

/** 値が近いものをまとめる（並べて、前との差が tol を超えたら次のまとまり） */
function cluster<T>(items: T[], key: (t: T) => number, tol: number): T[][] {
  const sorted = [...items].sort((a, b) => key(a) - key(b))
  const out: T[][] = []
  let last = -Infinity
  for (const it of sorted) {
    if (!out.length || key(it) - last > tol) out.push([])
    out[out.length - 1].push(it)
    last = key(it)
  }
  return out
}

const PX_PER_MM = INK_DPI / 25.4

/** mm の範囲のインクの範囲（mm）。なければ null */
function inkBox(mask: { data: Uint8ClampedArray, w: number, h: number }, x0: number, x1: number, top: number, bottom: number): number[] | null {
  const bx0 = Math.max(0, Math.floor(x0 * PX_PER_MM))
  const by0 = Math.max(0, Math.floor(top * PX_PER_MM))
  const bx1 = Math.min(mask.w, Math.floor(x1 * PX_PER_MM) + 1)
  const by1 = Math.min(mask.h, Math.floor(bottom * PX_PER_MM) + 1)
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const i = (y * mask.w + x) * 4
      const gray = 0.299 * mask.data[i] + 0.587 * mask.data[i + 1] + 0.114 * mask.data[i + 2]
      if (gray < INK_THRESHOLD) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  const r = (v: number) => Math.round(v * 100) / 100
  return [r(minX / PX_PER_MM), r(minY / PX_PER_MM), r((maxX + 1) / PX_PER_MM), r((maxY + 1) / PX_PER_MM)]
}

/** 1 文字のインクの範囲。罫線などが入り込んだら狭めて測り直す（extract_layout.py の char_ink と同じ） */
function charInk(mask: { data: Uint8ClampedArray, w: number, h: number }, c: LayoutChar): number[] | null {
  const tries: [number, number, number, number][] = [
    [c.x0 - 0.05, c.x1 + 0.05, c.b - 1.0 * c.s, c.b + 0.3 * c.s],
    [c.x0 + 0.05, c.x1 - 0.05, c.b - 0.92 * c.s, c.b + 0.16 * c.s],
  ]
  for (const [x0, x1, top, bottom] of tries) {
    const ink = inkBox(mask, x0, x1, top, bottom)
    if (!ink) return null
    if (ink[2] - ink[0] <= c.x1 - c.x0 + 0.3 && ink[3] - ink[1] <= 1.1 * c.s) return ink
  }
  return null
}
