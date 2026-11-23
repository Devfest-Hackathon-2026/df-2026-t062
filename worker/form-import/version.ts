// 様式の取り込み（#99）: ページごとの下書き（AI の答え）を、様式の版の形にする。
//   schemas      … pdfme のテンプレートの欄（ページごと。位置は mm、ページの左上が原点）
//   bindings     … 印字欄 → 値の対応（core/binding.ts。手で作った版と同じ書き方）
//   pages        … ページ（core/form.ts の FormPage）
//   localFields  … 事業所だけの欄の定義（form_template_versions.local_fields）
//   （図の枠は image の印字欄と diagram@1。手で作った版と同じ）
//   review       … 責任者に確かめてほしい欄（印字欄の名前と理由。form_imports.review）
// 推測で決めたところは、確定した対応にせず review に書く（何行目か分からない、印の意味が分からない、ない key など）。
import { checkBindings, specOf, type Binding, type Bindings, type Ref, type Step, type Test } from '../../core/binding.ts'
import { diagramKinds } from '../../core/diagram/fields.ts'
import { BY_KEY, choicesOf } from '../../core/fields.ts'
import type { FormPage } from '../../core/form.ts'
import type { PageDraft } from './convert.ts'
import type { DraftSlot, LocalField, Mark } from './draft.ts'

export interface ReviewItem {
  /** 印字欄の名前。様式全体のこと（定義の食い違いなど）は空 */
  slot: string
  reason: string
}

/** pdfme のテンプレートの欄（core/form.ts の TemplateSlot に、描くための属性を足したもの） */
export interface PdfmeSlot {
  name: string
  type: 'text' | 'circleMark' | 'image'
  content: string
  position: { x: number, y: number }
  width: number
  height: number
  [k: string]: unknown
}

export interface DraftVersion {
  schemas: PdfmeSlot[][]
  bindings: Bindings
  pages: FormPage[]
  localFields: LocalField[]
  review: ReviewItem[]
}

const FONT = { fontName: 'BIZUDPGothic', fontColor: '#1a3fa0', characterSpacing: 0 }
const PT_PER_MM = 72 / 25.4
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function pdfmeSlot(name: string, s: DraftSlot): PdfmeSlot {
  const at = { name, content: '', position: { x: s.x, y: s.y }, width: s.w, height: s.h }
  if (s.ui === 'diagram') return { ...at, type: 'image' }
  if (s.ui === 'circle') return { ...at, type: 'circleMark', content: 'false', rotate: 0, opacity: 1, color: FONT.fontColor, borderWidth: 0.3 }
  if (s.ui === 'check') {
    const size = clamp(Math.floor(Math.min(s.w, s.h) * PT_PER_MM * 0.9), 6, 12)
    return { ...at, type: 'text', ...FONT, fontSize: size, alignment: 'center', verticalAlignment: 'middle', lineHeight: 1 }
  }
  if (s.ui === 'area') {
    const size = clamp(Math.floor(s.h * PT_PER_MM * 0.75), 6, 9)
    return { ...at, type: 'text', ...FONT, fontSize: size, alignment: 'left', verticalAlignment: 'top', lineHeight: 1.1, dynamicFontSize: { min: 5, max: size, fit: 'vertical' } }
  }
  const size = clamp(Math.floor(s.h * PT_PER_MM * 0.75), 6, 10)
  return {
    ...at, type: 'text', ...FONT, fontSize: size, alignment: s.part ? 'center' : 'left', verticalAlignment: 'middle', lineHeight: 1.1,
    dynamicFontSize: { min: 5, max: size, fit: 'horizontal' },
  }
}

const TOP_KEYS = [...BY_KEY.keys()].sort((a, b) => b.length - a.length)

interface Parsed {
  ref: Ref
  /** 「[]」で、何行目か分からない */
  rowUnknown: boolean
  /** 一覧の行を範囲を含む条件で選ぶ欄（key[欄=値,欄=始め〜終わり].欄）。条件に合う行をすべて読む */
  rows?: { where: Record<string, Test>, show: string }
}

/** 1 桁の時（9:00）は 2 桁（09:00）にそろえる。値の一覧の時刻は HH:mm なので、文字のまま比べられるように */
const padTime = (v: string) => (/^\d:\d\d$/.test(v) ? `0${v}` : v)
const RANGE = /\s*[〜~～]\s*/

/**
 * AI の key の書き方（key、key.欄、key[0].欄、key[印].欄、key[欄=値].欄、key[欄=値,欄=値].欄、key[欄=始め〜終わり].欄、key[].欄）を Ref にする。
 * fields.json にない key・欄なら null
 */
export function parseRef(text: string): Parsed | null {
  const key = TOP_KEYS.find((k) => text === k || text.startsWith(`${k}.`) || text.startsWith(`${k}[`))
  if (!key) return null
  const path: Step[] = []
  let rowUnknown = false
  let range: Record<string, Test> | null = null
  let rest = text.slice(key.length)
  while (rest) {
    const m = rest.match(/^\[([^\]]*)\]/) ?? rest.match(/^\.([A-Za-z][A-Za-z0-9_]*)/)
    if (!m) return null
    if (m[0].startsWith('[')) {
      const inner = m[1]
      if (inner === '') { path.push(0); rowUnknown = true }
      else if (/^\d+$/.test(inner)) path.push(Number(inner))
      else if (inner.includes('=')) {
        const match: Record<string, string> = {}
        const where: Record<string, Test> = {}
        let hasRange = false
        for (const part of inner.split(',')) {
          const eq = part.indexOf('=')
          if (eq < 0) return null
          const k = part.slice(0, eq).trim()
          const v = part.slice(eq + 1).trim()
          // 条件の項目が、その一覧の行の項目にあるか
          if (!k || checkBindings({ x: { op: 'text@1', ui: 'text', ref: { key, path: [...path, 0, k] } } }).length) return null
          const r = v.split(RANGE)
          if (r.length === 2 && r[0] && r[1]) { where[k] = { between: [padTime(r[0]), padTime(r[1])] }; hasRange = true }
          else { match[k] = padTime(v); where[k] = { eq: padTime(v) } }
        }
        if (hasRange) { if (range || path.length) return null; range = where }
        path.push({ match })
      }
      else path.push({ flag: inner })
    } else {
      path.push(m[1])
    }
    rest = rest.slice(m[0].length)
  }
  const ref: Ref = path.length ? { key, path } : { key }
  // 欄の名前が fields.json にあるか（共通の確かめで見る）
  if (checkBindings({ x: { op: 'text@1', ui: 'text', ref: range ? { key, path: [0, ...path.slice(1)] } : ref } }).length) return null
  if (range) {
    // 範囲で選べるのは「一覧[条件].項目」の形だけ
    if (path.length !== 2 || typeof path[1] !== 'string') return null
    return { ref: { key }, rowUnknown: false, rows: { where: range, show: path[1] } }
  }
  return { ref, rowUnknown }
}

const ERAS: [string, 'M' | 'T' | 'S' | 'H' | 'R'][] = [['明', 'M'], ['大', 'T'], ['昭', 'S'], ['平', 'H'], ['令', 'R']]

/** 値の型と選択肢（共通の key は fields.json、事業所だけの欄はその定義） */
function specFor(ref: Ref, locals: Map<string, LocalField>): { type: string, choices: string[] } {
  if (ref.key.startsWith('local.')) {
    const d = locals.get(ref.key)
    return { type: d?.type ?? 'text', choices: d?.choices ?? [] }
  }
  const s = specOf(ref)
  return { type: s?.type ?? 'text', choices: s ? choicesOf(s) : [] }
}

export function buildVersion(drafts: PageDraft[]): DraftVersion {
  const review: ReviewItem[] = []
  const conflicts: ReviewItem[] = []
  const locals = new Map<string, LocalField>()
  const addLocal = (d: LocalField) => {
    const had = locals.get(d.key)
    if (!had) { locals.set(d.key, d); return }
    if (had.type !== d.type || JSON.stringify(had.choices ?? []) !== JSON.stringify(d.choices ?? [])) {
      const reason = `${d.key} の定義がページで違う（先の定義を使う）`
      if (!conflicts.some((c) => c.reason === reason)) conflicts.push({ slot: '', reason })
    }
  }
  for (const p of drafts) for (const d of p.localFields) addLocal(d)

  const bindings: Bindings = {}
  const used = new Set<string>()
  const schemas: PdfmeSlot[][] = []
  const pages: FormPage[] = []
  const sorted = [...drafts].sort((a, b) => a.page - b.page)
  for (const p of sorted) {
    for (const msg of p.problems) review.push({ slot: '', reason: `${p.page} ページ: ${msg}` })
    const pageSlots: PdfmeSlot[] = []
    p.slots.forEach((answered, i) => {
      const s = diagramUi(answered)
      const base = `p${p.page}_${s.label.replace(/\s+/g, '').slice(0, 40) || '欄'}`
      let name = base
      for (let n = 2; used.has(name); n++) name = `${base}_${n}`
      used.add(name)
      const fallbackKey = `local.p${p.page}_${i + 1}`
      const toLocal = (type: LocalField['type'], reason: string): Ref => {
        addLocal({ key: fallbackKey, label: s.label || name, type })
        review.push({ slot: name, reason })
        return { key: fallbackKey }
      }
      if (answered.ui === 'diagram' && s.ui !== 'diagram' && answered.ref) review.push({ slot: name, reason: `図の欄ではない key なので、文字の欄にした（${answered.ref}）` })
      bindings[name] = bindingOf(s, name, locals, toLocal, (reason) => review.push({ slot: name, reason }))
      pageSlots.push(pdfmeSlot(name, s))
    })
    schemas.push(pageSlots)
    pages.push({ no: p.page, pdfIndex: p.page - 1, title: `${p.page} ページ`, width: p.width, height: p.height })
  }
  // 共通の key の対応は、共通の仕組みの確かめも通す（通らないものは要確認）
  const shared = Object.fromEntries(Object.entries(bindings).filter(([, b]) => !b.ref.key.startsWith('local.')))
  for (const e of checkBindings(shared)) review.push({ slot: e.split(':')[0], reason: e.slice(e.indexOf(':') + 1).trim() })
  // 欄が使う事業所だけの欄の定義だけを残す
  const usedLocal = new Set(Object.values(bindings).map((b) => b.ref.key).filter((k) => k.startsWith('local.')))
  return { schemas, bindings, pages, localFields: [...locals.values()].filter((d) => usedLocal.has(d.key)), review: [...review, ...conflicts] }
}

/**
 * 図の欄（#128）。図の key（家族構成図・見取図・人体図）は、AI が文字の欄と答えても図の欄にする。
 * 図の枠と答えても図の key でなければ、複数行の文字の欄にする（図は決まった key にしか描けない）
 */
function diagramUi(s: DraftSlot): DraftSlot {
  const key = Object.keys(diagramKinds).find(k => s.ref === k || s.ref?.startsWith(k + '.') || s.ref?.startsWith(k + '['))
  const isDiagramKey = !!key
  if (isDiagramKey && (s.ui === 'text' || s.ui === 'area' || s.ui === 'diagram')) return { ...s, ref: key!, ui: 'diagram' }
  if (!isDiagramKey && s.ui === 'diagram') return { ...s, ui: 'area' }
  return s
}

function bindingOf(
  s: DraftSlot, name: string, locals: Map<string, LocalField>,
  toLocal: (type: LocalField['type'], reason: string) => Ref, note: (reason: string) => void,
): Binding {
  if (s.ui === 'diagram') return { op: 'diagram@1', ui: 'diagram', ref: { key: s.ref! } }
  const isMark = s.ui === 'check' || s.ui === 'circle'
  let parsed: Parsed | null = null
  if (s.ref?.startsWith('local.')) parsed = { ref: { key: s.ref }, rowUnknown: false }
  else if (s.ref) parsed = parseRef(s.ref)
  if (!parsed) {
    const ref = toLocal(isMark ? 'bool' : 'text', s.ref ? `値の一覧にない key なので、事業所だけの欄にした（${s.ref}）` : '値の key がないので、事業所だけの欄にした')
    return isMark ? { op: 'option@1', ui: s.ui as 'check' | 'circle', ref, is: { eq: true } } : { op: 'text@1', ui: s.ui === 'area' ? 'area' : 'text', ref }
  }
  if (parsed.rows) {
    if (!isMark) return { op: 'join@1', ui: s.ui === 'area' ? 'area' : 'text', ref: parsed.ref, where: parsed.rows.where, show: parsed.rows.show, sep: '\n' }
    return { op: 'option@1', ui: s.ui as 'check' | 'circle', ref: toLocal('bool', `範囲の条件で行を選べるのは文字の欄だけなので、事業所だけの欄にした（${s.ref}）`), is: { eq: true } }
  }
  let { ref } = parsed
  if (!isMark) {
    if (parsed.rowUnknown) note(`どの行の欄か分からないので、1 行目にした（${s.ref}）`)
    if (s.part === 'y' || s.part === 'm' || s.part === 'd') return { op: 'date@1', ui: 'text', ref, part: s.part }
    return { op: 'text@1', ui: s.ui === 'area' ? 'area' : 'text', ref }
  }
  const ui = s.ui as 'check' | 'circle'
  const label = s.label || name
  if (s.part === 'era') {
    // 「表すもの」が省かれていたら、そばの印字（明・大・昭…）から読む
    const v = s.mark && 'value' in s.mark ? s.mark.value : s.label
    const era = ERAS.find(([k, code]) => v.startsWith(k) || v === code)?.[1]
    if (era) return { op: 'era@1', ui: 'circle', ref, era }
    note(`元号が分からない（${v}）`)
  }
  // 「[]」の行の欄の印は、その欄がその値の行があるか（年金の種類の ✓ など）
  let rowField: string | null = null
  if (parsed.rowUnknown && ref.path?.length === 2 && ref.path[0] === 0 && typeof ref.path[1] === 'string') {
    rowField = ref.path[1]
  }
  const { type, choices } = specFor(ref, locals)
  const mark: Mark | undefined = s.mark ?? (type === 'bool' ? { kind: 'true' } : undefined)
  if (!mark) return { op: 'option@1', ui, ref: toLocal('bool', `印が何を表すか分からないので、事業所だけの「はい・いいえ」の欄にした（${s.ref}）`), is: { eq: true } }
  if (rowField) {
    const listRef: Ref = { key: ref.key }
    if (mark.kind === 'eq') return { op: 'option@1', ui, ref: listRef, is: { rowWhere: { [rowField]: { eq: mark.value } } } }
    if (mark.kind === 'none' && choices.length) {
      return { op: 'option@1', ui, ref: listRef, is: { rowWhere: { [rowField]: { notIn: choices } } }, edit: { on: { refuse: `「${label}」に当たる値を書いてください` }, off: { refuse: `「${label}」に当たる値を消してください` } } }
    }
    note(`どの行の欄か分からないので、1 行目にした（${s.ref}）`)
    ref = { key: ref.key, path: [0, rowField] }
  } else if (parsed.rowUnknown) {
    note(`どの行の欄か分からないので、1 行目にした（${s.ref}）`)
  }
  const on = (t: Test, edit?: Extract<Binding, { op: 'option@1' }>['edit']): Binding => ({ op: 'option@1', ui, ref, is: t, ...(edit ? { edit } : {}) })
  switch (mark.kind) {
    case 'eq': {
      const v = mark.value
      if (type === 'multi') return on({ has: v })
      if (choices.includes(v)) return on({ eq: v })
      if (choices.some((c) => c.startsWith(v))) return on({ startsWith: v }, { on: { refuse: `「${label}」に当たる値を書いてください` }, off: { set: [{ value: null }] } })
      if (choices.length) note(`選択肢にない値（${v}）`)
      return on({ eq: v })
    }
    case 'true': case 'false':
      if (type !== 'bool') note(`はい・いいえの key ではない（${s.ref}）`)
      return on({ eq: mark.kind === 'true' })
    case 'none':
      if (!choices.length) note(`選択肢のない key（${s.ref}）`)
      return on({ not: { in: choices } }, { on: { set: [{ value: null }] }, off: { refuse: `「${label}」以外の値を書いてください` } })
    case 'empty':
      return on({ empty: true }, { on: { set: [{ value: null }] }, off: { refuse: `「${label}」の中身を書いてください` } })
    case 'nonEmpty':
      return on({ nonEmpty: true }, { on: { refuse: `「${label}」の中身を書くと ✓ が付きます` }, off: { refuse: `「${label}」の中身を消すと ✓ が外れます` } })
  }
}
