// 責任者の画面（#102）で、印字欄に「何が入るか」を言葉で見せる・言葉で直す。
//   slotMeaning      … 対応 → 入る内容の言葉と、録音から AI が書くか
//   fieldCandidates  … 責任者の言葉を当てはめる先の欄（fields.json と、その版だけの欄）
//   bindingFromMatch … 当てはめた欄 → 対応
//   localFieldFor    … どの欄にも当たらなかったとき、その様式だけの欄（local.*）を作る
//   fakeFieldMatcher … 試しの当てはめ（AI なし。欄の名前が言葉に入っているか）
// 当てはめの本体（Gemini）は api/field-match.ts。責任者には key や op を見せない。
import type { Binding, Ref, Step } from './binding.ts'
import { fieldDict, writableFields, type FieldDict, type LocalField } from './dictionary.ts'
import { choicesOf, subFieldsOf, type FieldSpec, type FieldType } from './fields.ts'

export interface SlotMeaning {
  /** 入る内容（例: 緊急連絡先（1 行目）の電話番号） */
  what: string
  /** 録音で話に出たら AI が書く欄か */
  rec: boolean
  /** 丸・✓ の欄か（what は「印を付けるとき」） */
  mark?: true
}

const UNKNOWN = '（分からない欄）'

/** 欄の名前。行の中の項目は「まとまり（n 行目）の項目」 */
export function refLabel(ref: Ref, dict: FieldDict): string | null {
  const top = dict.get(ref.key)
  if (!top) return null
  let label = top.label
  let cur: FieldSpec = top
  for (const step of ref.path ?? []) {
    if (typeof step === 'number') label += `（${step + 1} 行目）`
    else if (typeof step === 'string') {
      const sub = subFieldsOf(cur).find((s) => s.key === step)
      if (!sub) return null
      label += `の${sub.label}`
      cur = sub
    } else if ('match' in step) {
      label += `（${Object.values(step.match).join('・')}の行）`
    }
  }
  return label
}

function testText(t: unknown): string | null {
  if (!t || typeof t !== 'object') return null
  const o = t as Record<string, unknown>
  if ('eq' in o) return o.eq === true ? '' : o.eq === false ? 'なし' : String(o.eq)
  if ('has' in o) return String(o.has)
  if ('in' in o && Array.isArray(o.in)) return o.in.join('・')
  if ('rowWhere' in o && o.rowWhere && typeof o.rowWhere === 'object') {
    return Object.values(o.rowWhere as Record<string, unknown>).map(testText).filter((x) => x).join('・') || null
  }
  return null
}

const topKey = (b: Binding) => b.ref.key

/** 対応 → 入る内容の言葉と、録音から AI が書くか */
export function slotMeaning(b: Binding, dict: FieldDict, localFields: readonly LocalField[] = []): SlotMeaning {
  const label = refLabel(b.ref, dict)
  const rec = writableFields({ keys: [topKey(b)], localFields }).length > 0 || (!!dict.get(topKey(b))?.local && !!dict.get(topKey(b))?.note)
  if (!label) return { what: UNKNOWN, rec: false, ...(b.ui === 'check' || b.ui === 'circle' ? { mark: true as const } : {}) }
  switch (b.op) {
    case 'option@1': {
      const v = testText(b.is)
      return { what: v ? `${label}が「${v}」` : label, rec, mark: true }
    }
    case 'era@1': return { what: `${label}の元号が${b.era}`, rec, mark: true }
    case 'date@1': return { what: `${label}の${b.part === 'y' ? '年' : b.part === 'm' ? '月' : '日'}`, rec }
    default: return { what: label, rec }
  }
}

// ---------- 言葉から欄を当てはめる ----------

export interface FieldCandidate {
  /** 欄の key。行の中の項目は「まとまりの key[].項目の key」 */
  id: string
  label: string
  type: FieldType
  choices?: string[]
  /** 行の中の項目（何行目かを決める） */
  list?: true
  /** 欄の説明（AI の手がかり） */
  note?: string
}

export interface MatchInput {
  /** 責任者が書いた「ここに何が入るか」 */
  text: string
  /** 丸・✓ の欄か */
  mark: boolean
  candidates: FieldCandidate[]
}

/** 当てはめの結果。row は行の中の項目のとき何行目か（1 から）。choice は選ぶ欄のとき、印を付ける値 */
export type MatchResult = { id: string, row?: number, choice?: string } | null
export type FieldMatcher = (input: MatchInput) => Promise<MatchResult>

const TEXT_TYPES = new Set<FieldType>(['text', 'longtext', 'date', 'number', 'enum'])
const MARK_TYPES = new Set<FieldType>(['enum', 'multi', 'bool'])

const candidateOf = (id: string, f: FieldSpec, label: string, list?: true): FieldCandidate => ({
  id, label, type: f.type,
  ...(choicesOf(f).length ? { choices: choicesOf(f) } : {}),
  ...(list ? { list } : {}),
  ...(f.note ? { note: f.note } : {}),
})

/** 当てはめる先の欄。文字の欄には文字で出せる欄、丸・✓ の欄には選ぶ欄。行の中の項目（1 段まで）と、その版だけの欄も入る */
export function fieldCandidates(mark: boolean, localFields: readonly LocalField[]): FieldCandidate[] {
  const ok = mark ? MARK_TYPES : TEXT_TYPES
  const out: FieldCandidate[] = []
  for (const f of fieldDict(localFields).list) {
    if (f.type === 'list' || f.type === 'object') {
      for (const s of subFieldsOf(f)) if (ok.has(s.type)) out.push(candidateOf(`${f.key}[].${s.key}`, s, `${f.label}の${s.label}`, f.type === 'list' ? true : undefined))
      continue
    }
    if (ok.has(f.type)) out.push(candidateOf(f.key, f, f.label))
  }
  return out
}

/** 丸・✓ の欄か（対応が丸・✓、または印字欄が丸の印） */
export function isMarkSlot(slot: { type: string }, b: Binding | undefined): boolean {
  if (b) return b.ui === 'check' || b.ui === 'circle'
  return slot.type === 'circleMark'
}

export interface SlotShape {
  mark: boolean
  /** 印字欄の高さ（mm） */
  height: number
  /** 今の対応（見せ方を引き継ぐ） */
  prev?: Binding
  /** 印字欄が丸の印か */
  circle?: boolean
}

/** 何行も書ける高さ（mm） */
const AREA_HEIGHT = 14

function refOf(id: string, row: number | undefined, dict: FieldDict): { ref: Ref, spec: FieldSpec } | null {
  const m = /^(.+)\[\]\.(.+)$/.exec(id)
  if (!m) {
    const spec = dict.get(id)
    return spec ? { ref: { key: id }, spec } : null
  }
  const parent = dict.get(m[1])
  const spec = parent && subFieldsOf(parent).find((s) => s.key === m[2])
  if (!parent || !spec) return null
  const path: Step[] = parent.type === 'list' ? [Math.max(1, row ?? 1) - 1, m[2]] : [m[2]]
  return { ref: { key: m[1], path }, spec }
}

/** 当てはめた欄 → 対応。当てはめが欄の形に合わなければ null */
export function bindingFromMatch(match: NonNullable<MatchResult>, shape: SlotShape, localFields: readonly LocalField[]): Binding | null {
  const hit = refOf(match.id, match.row, fieldDict(localFields))
  if (!hit) return null
  const { ref, spec } = hit
  if (shape.mark) {
    if (!MARK_TYPES.has(spec.type)) return null
    const ui = shape.prev?.ui === 'circle' || shape.circle ? 'circle' : 'check'
    if (spec.type === 'bool') return { op: 'option@1', ui, ref, is: { eq: true } }
    if (!match.choice || !choicesOf(spec).includes(match.choice)) return null
    return { op: 'option@1', ui, ref, is: spec.type === 'multi' ? { has: match.choice } : { eq: match.choice } }
  }
  if (!TEXT_TYPES.has(spec.type)) return null
  const prevUi = shape.prev && (shape.prev.op === 'text@1' || shape.prev.op === 'join@1') ? shape.prev.ui : null
  return { op: 'text@1', ui: prevUi ?? (shape.height >= AREA_HEIGHT ? 'area' : 'text'), ref }
}

/** どの欄にも当たらなかったとき、その様式だけの欄を作る。名前と説明は書いた言葉（説明があるので、録音から AI が書く） */
export function localFieldFor(text: string, shape: SlotShape, have: readonly LocalField[]): LocalField {
  const label = text.trim().slice(0, 60)
  const used = new Set(have.map((f) => f.key))
  let n = 1
  while (used.has(`local.custom_${n}`)) n++
  const type: LocalField['type'] = shape.mark ? 'bool' : shape.height >= AREA_HEIGHT ? 'longtext' : 'text'
  return { key: `local.custom_${n}`, label, type, note: text.trim() }
}

// ---------- 試しの当てはめ ----------

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '')

/** 試しの当てはめ（AI なし・費用なし）。欄の名前が言葉に入っていれば、いちばん長い名前の欄。行の番号と選ぶ値も言葉から読む */
export const fakeFieldMatcher: FieldMatcher = async ({ text, candidates }) => {
  const t = norm(text)
  let best: FieldCandidate | null = null
  for (const c of candidates) {
    const l = norm(c.label)
    if (l && t.includes(l) && (!best || l.length > norm(best.label).length)) best = c
  }
  if (!best) return null
  const out: NonNullable<MatchResult> = { id: best.id }
  if (best.list) {
    const row = /(\d+)(?:行目|人目|番目)/.exec(t)
    if (row) out.row = Number(row[1])
  }
  if (best.choices?.length) {
    const rest = t.replace(norm(best.label), '')
    const choice = [...best.choices].sort((a, b) => b.length - a.length).find((c) => rest.includes(norm(c)))
    if (choice) out.choice = choice
  }
  return out
}
