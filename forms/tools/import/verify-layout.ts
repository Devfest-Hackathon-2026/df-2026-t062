// Node.js の取り出し（worker/form-import/pdf.ts）が、Python の取り出し（scripts/extract_layout.py の layout.json）と同じ結果になるかを確かめる。
// AI は呼ばない（費用はかからない）。
//
//   node forms/tools/import/verify-layout.ts <PDF> <layout.json> [<PDF> <layout.json> ...]
//
// 比べるもの（ずれは 0.3mm まで同じとみなす。インクは 0.15mm まで）:
//   文字 … Python の文字のうち、Node に同じ文字で、横の枠（x0・x1）と基準線（b）が同じものがあるもの。
//          縦の枠（y0・y1）は「基準線＋フォントの descent」で決まり、descent の読み方が pdfplumber と pdfjs で違うので、ずれの大きさを別に出す
//   語   … Python の語のうち、Node に同じ語で、横の枠が同じ・上端のずれが 0.8mm 以内のものがあるもの
//   罫線 … Python の横線・縦線のうち、Node に同じ線があるもの（と、その逆）
//   □ のインク … Python で □ のインクを測れたもののうち、Node のインクの範囲が同じもの
//   マスと □ … 両方の取り出しから findCells・findBoxes で作った一覧が同じか（変換に効くのはここ）
//   手の版 … 手で作った様式（forms/seed/<様式>/template.json）がある PDF では、手の版の欄が
//            ✓ の欄なら □ に、文字の欄ならマスの中に入る割合を、Python と Node の両方で数える（どちらの取り出しが正しいかの決め手）
//            その PDF の様式は --seed <様式> で PDF の前に書く
import { readFileSync } from 'node:fs'
import { openPdf, type LayoutPage } from '../../../worker/form-import/pdf.ts'
import { findBoxes, findCells, type Cell } from '../../../worker/form-import/geometry.ts'

const TOL = 0.3
const INK_TOL = 0.15
const near = (a: number, b: number, tol = TOL) => Math.abs(a - b) <= tol
const box4 = (a: { x0: number, y0: number, x1: number, y1: number }, b: typeof a, tol = TOL) => near(a.x0, b.x0, tol) && near(a.y0, b.y0, tol) && near(a.x1, b.x1, tol) && near(a.y1, b.y1, tol)
const pct = (n: number, d: number) => (d ? `${n}/${d}（${(n / d * 100).toFixed(1)}%）` : '0/0')

function matchLines(a: [number, number, number][], b: [number, number, number][]) {
  return a.filter(([p, s, e]) => b.some(([q, t, f]) => near(p, q) && near(s, t) && near(e, f))).length
}
const sameCells = (a: Cell[], b: Cell[]) => a.filter((c) => b.some((d) => near(c.x, d.x) && near(c.y, d.y) && near(c.w, d.w) && near(c.h, d.h))).length

const argv = process.argv.slice(2)
const seeds = new Map<string, string>()
const args: string[] = []
for (let k = 0; k < argv.length; k++) {
  if (argv[k] === '--seed') { seeds.set(argv[k + 2], argv[k + 1]); k++; continue }
  args.push(argv[k])
}
if (args.length < 2 || args.length % 2) throw new Error('使い方: verify-layout.ts <PDF> <layout.json> ...')
const total = { handBoxPy: [0, 0], handBoxNode: [0, 0], handCellPy: [0, 0], handCellNode: [0, 0], chars: [0, 0], words: [0, 0], h: [0, 0], v: [0, 0], hBack: [0, 0], vBack: [0, 0], ink: [0, 0], cells: [0, 0], cellsBack: [0, 0], boxes: [0, 0], boxesBack: [0, 0] }
const add = (k: keyof typeof total, n: number, d: number) => { total[k][0] += n; total[k][1] += d }

for (let i = 0; i < args.length; i += 2) {
  const py = JSON.parse(readFileSync(args[i + 1], 'utf8')).pages as LayoutPage[]
  const pdf = await openPdf(new Uint8Array(readFileSync(args[i])))
  const seed = seeds.get(args[i])
  const hand = seed ? {
    schemas: JSON.parse(readFileSync(`forms/seed/${seed}/template.json`, 'utf8')).schemas as { name: string, position: { x: number, y: number }, width: number, height: number }[][],
    bindings: JSON.parse(readFileSync(`forms/seed/${seed}/bindings.json`, 'utf8')) as Record<string, { ui: string }>,
  } : null
  const descentShift: number[] = []
  try {
    for (const p of py) {
      const n = await pdf.layout(p.page, { ink: true })
      const chars = p.chars.filter((c) => {
        const d = n.chars.find((d) => d.t === c.t && near(c.x0, d.x0) && near(c.x1, d.x1) && near(c.b, d.b))
        if (d) descentShift.push(Math.abs(d.y0 - c.y0))
        return !!d
      }).length
      const words = p.words.filter((w) => n.words.some((d) => d.t === w.t && near(w.x0, d.x0) && near(w.x1, d.x1) && near(w.y0, d.y0, 0.8))).length
      const boxGlyphs = p.chars.filter((c) => '□☐▢◻⬜❏❑'.includes(c.t) && c.ink)
      const ink = boxGlyphs.filter((c) => n.chars.some((d) => d.t === c.t && box4(c, d) && d.ink && d.ink.every((v, k) => near(v, c.ink![k], INK_TOL)))).length
      const pc = findCells(p), nc = findCells(n), pb = findBoxes(p), nb = findBoxes(n)
      const row = {
        chars: pct(chars, p.chars.length), words: pct(words, p.words.length),
        横線: `${pct(matchLines(p.hlines, n.hlines), p.hlines.length)} 逆 ${pct(matchLines(n.hlines, p.hlines), n.hlines.length)}`,
        縦線: `${pct(matchLines(p.vlines, n.vlines), p.vlines.length)} 逆 ${pct(matchLines(n.vlines, p.vlines), n.vlines.length)}`,
        '□インク': pct(ink, boxGlyphs.length),
        マス: `${pct(sameCells(pc, nc), pc.length)} 逆 ${pct(sameCells(nc, pc), nc.length)}`,
        '□': `${pct(sameCells(pb, nb), pb.length)} 逆 ${pct(sameCells(nb, pb), nb.length)}`,
      }
      if (hand && hand.schemas[p.page - 1]?.length) {
        const inside = (s: { position: { x: number, y: number }, width: number, height: number }, cs: Cell[]) => {
          const cx = s.position.x + s.width / 2, cy = s.position.y + s.height / 2
          return cs.some((c) => cx >= c.x - 0.3 && cx <= c.x + c.w + 0.3 && cy >= c.y - 0.3 && cy <= c.y + c.h + 0.3)
        }
        const slots = hand.schemas[p.page - 1]
        const checks = slots.filter((s) => hand.bindings[s.name]?.ui === 'check')
        const texts = slots.filter((s) => ['text', 'area'].includes(hand.bindings[s.name]?.ui))
        const hb = [checks.filter((s) => inside(s, pb)).length, checks.filter((s) => inside(s, nb)).length]
        const hc = [texts.filter((s) => inside(s, pc)).length, texts.filter((s) => inside(s, nc)).length]
        Object.assign(row, { '手の✓が□に（Py／Node）': `${hb[0]}／${hb[1]}／${checks.length}`, '手の文字の欄がマスに（Py／Node）': `${hc[0]}／${hc[1]}／${texts.length}` })
        add('handBoxPy', hb[0], checks.length); add('handBoxNode', hb[1], checks.length)
        add('handCellPy', hc[0], texts.length); add('handCellNode', hc[1], texts.length)
      }
      console.log(`${args[i].split('/').pop()} p${p.page}`, JSON.stringify(row))
      add('chars', chars, p.chars.length); add('words', words, p.words.length)
      add('h', matchLines(p.hlines, n.hlines), p.hlines.length); add('hBack', matchLines(n.hlines, p.hlines), n.hlines.length)
      add('v', matchLines(p.vlines, n.vlines), p.vlines.length); add('vBack', matchLines(n.vlines, p.vlines), n.vlines.length)
      add('ink', ink, boxGlyphs.length)
      add('cells', sameCells(pc, nc), pc.length); add('cellsBack', sameCells(nc, pc), nc.length)
      add('boxes', sameCells(pb, nb), pb.length); add('boxesBack', sameCells(nb, pb), nb.length)
    }
  } finally { await pdf.close() }
  descentShift.sort((a, b) => a - b)
  if (descentShift.length) console.log(`  縦の枠のずれ（descent の差）: 中央値 ${descentShift[Math.floor(descentShift.length / 2)].toFixed(2)}mm、最大 ${descentShift.at(-1)!.toFixed(2)}mm`)
}
console.log('合計', JSON.stringify(Object.fromEntries(Object.entries(total).map(([k, [n, d]]) => [k, pct(n, d)]))))
