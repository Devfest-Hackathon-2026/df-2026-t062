// 様式の取り込み（#99）: AI が答える欄（下書き）の形と、答えを当てる・確かめる処理。AI は呼ばない。
//   addMissing・applyReview … 見直しの答え（漏れの追加・直し・取り除き）を当てる
//   defaultMarks           … はい・いいえの key の印に「表すもの」がなければ「はい」とする
//   fixLocalPrefix・mergeLocalFields … 事業所だけの欄（local.*）の定義を整え、欄と突き合わせる

/** AI が答える 1 欄 */
export interface DraftSlot {
  x: number
  y: number
  w: number
  h: number
  /** text: 1 行、area: 複数行、check: □ に ✓、circle: 文字を丸で囲む */
  ui: 'text' | 'area' | 'check' | 'circle'
  /** 入れる値の key（catalog の書き方）。合う key がなければ null（事業所だけの欄） */
  ref: string | null
  /** check・circle のとき、その印が表すもの（値が X・どれでもない・はい・いいえ・空・空でない） */
  mark?: Mark
  /** 日付を年・月・日に分けて書く欄のとき */
  part?: 'y' | 'm' | 'd' | 'era'
  /** 表のマス（findCells の id）全体が欄のとき、その番号。あれば位置はマスの内側に置き直す */
  cell?: number
  /** □（findBoxes の id）に ✓ を付ける欄のとき、その番号。あれば位置は □ に置き直す */
  box?: number
  /** 欄のそばに印字されている文字（どの欄か人が分かるように） */
  label: string
  confidence: number
}

/** □・丸の印が表すもの。eq は値が value（で始まる）、none は選択肢のどれでもない、true・false ははい・いいえ、empty・nonEmpty は空・空でない */
export type Mark = { kind: 'eq', value: string } | { kind: 'none' | 'true' | 'false' | 'empty' | 'nonEmpty' }

const MARK_UI = new Set(['check', 'circle', 'cell'])
/** 欄の種類の大きな分け方（印か文字か）。重なりを見るときに使う */
export const family = (ui: string) => (MARK_UI.has(ui) ? 'mark' : 'text')

/** 続きの答えから、すでに出した欄とほぼ同じ位置（1.5mm 以内）・同じ種類の欄を除いて足す */
export function addMissing(have: DraftSlot[], more: DraftSlot[]): DraftSlot[] {
  const same = (a: DraftSlot, b: DraftSlot) => family(a.ui) === family(b.ui) && Math.abs(a.x - b.x) <= 1.5 && Math.abs(a.y - b.y) <= 1.5
  const out = [...have]
  for (const m of more) if (!out.some((h) => same(h, m))) out.push(m)
  return out
}

/** 事業所だけの欄の定義（版の local_fields になる）。note は後の AI に欄の意味を伝えるため */
export interface LocalField { key: string, label: string, type: 'text' | 'longtext' | 'date' | 'number' | 'enum' | 'bool', choices?: string[], note?: string }

const LOCAL_KEY = /^local\.[a-zA-Z][a-zA-Z0-9_]*$/

/** 欄が使う local.* と定義を突き合わせる。使われる定義だけを残し、食い違いは problems に書く（要確認に回す） */
export function mergeLocalFields(slots: DraftSlot[], defs: LocalField[]): { fields: LocalField[], problems: string[] } {
  const problems: string[] = []
  const byKey = new Map<string, LocalField>()
  for (const d of defs) {
    if (!LOCAL_KEY.test(d.key)) { problems.push(`${d.key} は local.<英字> の形でない`); continue }
    const had = byKey.get(d.key)
    if (had) {
      // 見直しの回で同じ定義を書き直して返すことがある。中身が違うときだけ要確認にする
      if (JSON.stringify(had) !== JSON.stringify({ ...had, ...d })) problems.push(`${d.key} の定義が 2 つある（先の定義を使う）`)
      continue
    }
    byKey.set(d.key, d)
  }
  const used = new Set<string>()
  let none = 0
  for (const s of slots) {
    if (s.ref === null) { none++; continue }
    if (!s.ref.startsWith('local.')) continue
    if (byKey.has(s.ref)) used.add(s.ref)
    else if (!problems.includes(`${s.ref} を使う欄があるが定義がない`)) problems.push(`${s.ref} を使う欄があるが定義がない`)
  }
  if (none) problems.push(`値の key も local.* もない欄が ${none} つある`)
  return { fields: [...byKey.values()].filter((d) => used.has(d.key)), problems }
}

export interface Review { slots?: DraftSlot[], fixes?: { id: number, slot: DraftSlot }[], removes?: number[] }

/** 見直しの答えを当てる。番号は、見直しに渡した欄の一覧の 1 からの番号。ない番号は無視する */
export function applyReview(have: DraftSlot[], review: Review): { slots: DraftSlot[], changes: { fixed: number, removed: number, added: number } } {
  const next: (DraftSlot | null)[] = [...have]
  let fixed = 0
  let removed = 0
  for (const f of review.fixes ?? []) {
    if (f.id >= 1 && f.id <= have.length && next[f.id - 1]) { next[f.id - 1] = f.slot; fixed++ }
  }
  for (const id of review.removes ?? []) {
    if (id >= 1 && id <= have.length && next[id - 1]) { next[id - 1] = null; removed++ }
  }
  const kept = next.filter((s): s is DraftSlot => s !== null)
  const slots = addMissing(kept, review.slots ?? [])
  return { slots, changes: { fixed, removed, added: slots.length - kept.length } }
}

/** local. を付け忘れた事業所だけの欄の定義と、その名前をそのまま ref にした欄に local. を補う（値の key と同じ名前なら補わない） */
export function fixLocalPrefix(slots: DraftSlot[], defs: LocalField[], knownKeys: string[]): { slots: DraftSlot[], defs: LocalField[] } {
  const known = new Set(knownKeys)
  const bare = new Set(defs.filter((d) => !d.key.startsWith('local.') && !known.has(d.key)).map((d) => d.key))
  return {
    defs: defs.map((d) => (bare.has(d.key) ? { ...d, key: `local.${d.key}` } : d)),
    slots: slots.map((s) => (s.ref !== null && bare.has(s.ref) ? { ...s, ref: `local.${s.ref}` } : s)),
  }
}

/** はい・いいえの key（型 bool）の印に「表すもの」がなければ「はい」とみなす。□ に ✓ が付く ＝ はい、が決まっているため */
export function defaultMarks(slots: DraftSlot[], types: Map<string, string>): DraftSlot[] {
  return slots.map((s) => {
    if ((s.ui !== 'check' && s.ui !== 'circle') || s.mark || s.ref === null) return s
    return types.get(s.ref.replace(/\[[^\]]*\]/g, '[]')) === 'bool' ? { ...s, mark: { kind: 'true' } } : s
  })
}

const LOCAL_ROW = /^(local\.[A-Za-z][A-Za-z0-9_]*)\[([^\]]*)\](?:\.([A-Za-z][A-Za-z0-9_]*))?$/

/**
 * 行のある事業所だけの欄（local.x[0]、local.x[2].name）を、行ごとの欄（local.x_1、local.x_3_name）にする。
 * local_fields は fields.json の欄と同じ平らな形で、行を持たない（2026-11-19 に決めた。表の行は用紙で数が決まっているため）。
 * 定義は元の欄の定義から行ごとに作り、名前に何行目かを付ける。何行目か分からない（[]）ときは 1 行目にして problems に書く
 */
export function flattenLocalRows(slots: DraftSlot[], defs: LocalField[]): { slots: DraftSlot[], defs: LocalField[], problems: string[] } {
  const byKey = new Map(defs.map((d) => [d.key, d]))
  const problems: string[] = []
  const created = new Map<string, LocalField>()
  const bases = new Set<string>()
  const direct = new Set(slots.map((s) => s.ref))
  const out = slots.map((s) => {
    const m = s.ref?.match(LOCAL_ROW)
    if (!m) return s
    const [, base, index, sub] = m
    bases.add(base)
    let row = Number(index) + 1
    if (!/^\d+$/.test(index)) {
      row = 1
      const msg = `${s.ref} は何行目か分からないので 1 行目にした`
      if (!problems.includes(msg)) problems.push(msg)
    }
    const key = `${base}_${row}${sub ? `_${sub}` : ''}`
    if (!created.has(key)) {
      const def = byKey.get(base)
      if (!def) {
        const msg = `${base} の定義がないので、欄のそばの文字を名前にした`
        if (!problems.includes(msg)) problems.push(msg)
      }
      const label = def ? `${def.label}（${row} 行目）${sub ? `の ${sub}` : ''}` : `${s.label}（${row} 行目）`
      created.set(key, { ...(def ?? { type: 'text' as const }), key, label })
    }
    return { ...s, ref: key }
  })
  const kept = defs.filter((d) => !(bases.has(d.key) && !direct.has(d.key)))
  return { slots: out, defs: [...kept, ...created.values()], problems }
}
