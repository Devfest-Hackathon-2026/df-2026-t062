// 書類を作るときに AI が書く（#195）の、プログラムが決める部分。DB にも AI にも触らない。
//   fillTargets … AI に渡す欄（流れの 3「書く欄を決める」）
//   overflowKeys … 欄からはみ出す文字の欄（流れの 6「確かめる」。PDF のはみ出しの確かめと同じ計算）
//   isCut … 最後の確かめの答えが、前の値から切っただけか（流れの 7）
import { renderAll } from './binding.ts'
import { writableFields } from './dictionary.ts'
import { slotPages, type FormDef, type TemplateSlot } from './form.ts'
import { fitsSlot, slotChars } from './print-layout.ts'

export interface FillTarget {
  key: string
  /** 用紙のページ番号（印字欄がページにないときは 0） */
  page: number
  /** 欄の名前（最初の印字欄） */
  slot: string
  /** 入るおよその文字数（文字の欄だけ。ほかは null） */
  chars: number | null
  /** 今の値（空なら null） */
  current: unknown
  /** 元の書類から写した値か */
  copied: boolean
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' ||
  (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)

const isText = (type: string) => type === 'text' || type === 'longtext'

/** 版の、その key を読む文字の印字欄（行やまとまりの中の項目を読む欄は除く） */
function textSlots(form: Pick<FormDef, 'schemas' | 'bindings'>): Map<string, TemplateSlot[]> {
  const out = new Map<string, TemplateSlot[]>()
  for (const slot of form.schemas.flat()) {
    const b = form.bindings[slot.name]
    if (slot.type !== 'text' || b?.op !== 'text@1' || b.ref.path?.length) continue
    out.set(b.ref.key, [...(out.get(b.ref.key) ?? []), slot])
  }
  return out
}

/**
 * AI に渡す欄。版が読む、AI が書いてよい欄（録音からの書き込みと同じ。その様式だけの欄は note がなくても入れる）のうち:
 *   - 文字の欄（短い文・長い文）: 写した値があってもなくても
 *   - ほかの型の欄: 値が空のときだけ（写した日付・選択肢・はい／いいえ・数は書き直させない）
 * ケアマネが書いた欄は入れない。並びは欄の辞書の順
 */
export function fillTargets(form: FormDef, current: Readonly<Record<string, { value: unknown, by: string } | undefined>>, copied: ReadonlySet<string>): FillTarget[] {
  const pageOf = slotPages(form)
  const firstSlot = new Map<string, string>()
  for (const [slot, b] of Object.entries(form.bindings)) if (!firstSlot.has(b.ref.key)) firstSlot.set(b.ref.key, slot)
  const texts = textSlots(form)
  const out: FillTarget[] = []
  for (const f of writableFields(form)) {
    const cur = current[f.key]
    const empty = isEmpty(cur?.value)
    if (!empty && cur?.by === 'cm') continue
    if (!empty && !isText(f.type)) continue
    const slot = firstSlot.get(f.key) ?? ''
    const box = isText(f.type) ? texts.get(f.key)?.[0] : undefined
    out.push({
      key: f.key, page: pageOf.get(slot) ?? 0, slot, chars: box ? slotChars(box) : null,
      current: empty ? null : cur!.value, copied: !empty && copied.has(f.key),
    })
  }
  return out
}

/** 欄からはみ出す文字の欄の key（印字欄に入れた文で確かめる） */
export function overflowKeys(form: Pick<FormDef, 'schemas' | 'bindings'>, values: Readonly<Record<string, unknown>>): Set<string> {
  const rendered = renderAll(form.bindings, values)
  const out = new Set<string>()
  for (const [key, slots] of textSlots(form)) {
    if (slots.some((slot) => !fitsSlot(rendered[slot.name] ?? '', slot))) out.add(key)
  }
  return out
}

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '')

/**
 * 最後の確かめの答え（after）が、前の値（before）から切っただけか。文字の値は、空白を除いた文字の並びが前の値の中に順に残っていること。
 * ほかの値は、同じか空。語を足す・変える答えは通さない
 */
export function isCut(after: unknown, before: unknown): boolean {
  if (isEmpty(after)) return true
  if (typeof after !== 'string' || typeof before !== 'string') return JSON.stringify(after) === JSON.stringify(before)
  const a = norm(after), b = norm(before)
  let i = 0
  for (const ch of b) if (i < a.length && a[i] === ch) i++
  return i === a.length
}
