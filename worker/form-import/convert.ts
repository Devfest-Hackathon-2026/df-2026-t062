// 様式の取り込み（#99）: 1 ページを変換する。#110 で決めた方式（実物の様式で精度を測って決めた）:
//   1. 位置の候補はプログラムが PDF から出す（表のマスと □。番号を付ける）
//   2. Gemini にページの画像・文字と罫線・マスと □ の一覧・key の一覧を渡し、欄を答えさせる（マスと □ は番号で）
//   3. 番号で答えた欄は、マスの内側・□ の位置に置き直す。ページの外の欄は捨てる
//   4. 見直し: ここまでの欄を枠と番号で重ねた画像を渡し、漏れの追加・直し・取り除きを答えさせる。
//      どの欄にも使われていない □ はプログラムが挙げる。変わらなくなるか、reviewMax 回まで
//   5. はい・いいえの key の印に「表すもの」がなければ「はい」。local. の付け忘れを補い、行のある事業所だけの欄は行ごとの欄にして、定義と突き合わせる
import type { Ask } from '../vertex/gemini.ts'
import { applyReview, defaultMarks, fixLocalPrefix, flattenLocalRows, mergeLocalFields, type DraftSlot, type LocalField } from './draft.ts'
import { findBoxes, findCells, placeInBoxes, placeInCells, unusedBoxes, type Cell } from './geometry.ts'
import { correctPrintedGeometry, normalizeEraChoices } from './integrity.ts'
import { overlayPng } from './overlay.ts'
import type { OpenedPdf } from './pdf.ts'
import { catalogTypes, FIRST_SCHEMA, firstPrompt, REVIEW_SCHEMA, reviewPrompt } from './prompt.ts'

/** 1 回目に渡すページの画像の細かさ（試しで決めた） */
export const PAGE_DPI = 150
export const REVIEW_MAX = 3

export interface Round { added: number, fixed: number, removed: number }

export interface PageDraft {
  page: number
  /** ページの大きさ（mm） */
  width: number
  height: number
  /** 欄（位置は mm、ページの左上が原点） */
  slots: DraftSlot[]
  /** 欄が使う事業所だけの欄の定義 */
  localFields: LocalField[]
  /** 事業所だけの欄の定義の食い違い（要確認に回す） */
  problems: string[]
  cells: Cell[]
  boxes: Cell[]
  rounds: Round[]
  /** ページの外にはみ出したので捨てた欄の数 */
  outside: number
}

export interface ConvertDeps {
  ask: Ask
  /** key の一覧（prompt.ts の catalog()） */
  catalog: string[]
  reviewMax?: number
}

export async function convertPage(pdf: OpenedPdf, pageNo: number, deps: ConvertDeps): Promise<PageDraft> {
  const page = await pdf.layout(pageNo, { ink: true })
  const boxes = findBoxes(page)
  // □ と同じ場所の小さいマスは、マスでなく □ として扱う
  const cells = findCells(page).filter((c) => !boxes.some((b) => Math.abs(b.x + b.w / 2 - (c.x + c.w / 2)) <= 1 && Math.abs(b.y + b.h / 2 - (c.y + c.h / 2)) <= 1))
  const first = [
    { png: await pdf.png(pageNo, PAGE_DPI) },
    { text: firstPrompt({ page, cells, boxes, catalog: deps.catalog }) },
  ]
  // ページの外にはみ出した欄は捨てる（1mm までは許す）
  const inside = (d: DraftSlot) => d.x >= -1 && d.y >= -1 && d.x + d.w <= page.width + 1 && d.y + d.h <= page.height + 1
  let outside = 0
  const fit = (xs: DraftSlot[]) => {
    const placed = correctPrintedGeometry(placeInBoxes(placeInCells(xs, cells), boxes), page)
    const ok = placed.filter(inside)
    outside += placed.length - ok.length
    return ok
  }

  const body0 = await deps.ask(first, FIRST_SCHEMA, { step: '様式の欄', group: pageNo }) as { slots?: DraftSlot[], localFields?: LocalField[] }
  let slots = fit(body0.slots ?? [])
  let localDefs = [...(body0.localFields ?? [])]
  const rounds: Round[] = [{ added: slots.length, fixed: 0, removed: 0 }]

  const reviewMax = deps.reviewMax ?? REVIEW_MAX
  for (let r = 0; r < reviewMax; r++) {
    // 2 回目からも 1 回目の入力を同じ並びで先に置く（キャッシュに当たれば、その分の入力は安い）
    const prompt = [...first, { png: await overlayPng(pdf, pageNo, slots) }, { text: reviewPrompt(slots, unusedBoxes(slots, boxes)) }]
    const body = await deps.ask(prompt, REVIEW_SCHEMA, { step: '様式の見直し', group: pageNo }) as { slots?: DraftSlot[], fixes?: { id: number, slot: DraftSlot }[], removes?: number[], localFields?: LocalField[] }
    localDefs = [...localDefs, ...(body.localFields ?? [])]
    const fixes = (body.fixes ?? []).flatMap(f => fit([f.slot]).map(slot => ({ id: f.id, slot })))
    const applied = applyReview(slots, { slots: fit(body.slots ?? []), fixes, removes: body.removes ?? [] })
    slots = applied.slots
    rounds.push(applied.changes)
    if (applied.changes.added + applied.changes.fixed + applied.changes.removed === 0) break
  }

  const fixed = fixLocalPrefix(slots, localDefs, deps.catalog.map((l) => l.split('｜')[0]))
  const normalized = normalizeEraChoices(fixed.slots, fixed.defs, pageNo)
  const flat = flattenLocalRows(normalized.slots, normalized.fields)
  const types = catalogTypes(deps.catalog)
  for (const d of flat.defs) if (!types.has(d.key)) types.set(d.key, d.type)
  slots = defaultMarks(flat.slots, types)
  const local = mergeLocalFields(slots, flat.defs)
  return { page: pageNo, width: page.width, height: page.height, slots, localFields: local.fields, problems: [...flat.problems, ...local.problems], cells, boxes, rounds, outside }
}
