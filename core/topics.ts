// 書類の種類ごとの「まとめる項目」（form_kinds.topics）と、事業所が直した項目（office_topics）を合わせた一覧。
// docs/再設計/17_録音からの書き込み.md の「まとめる項目」「事業所が直せる項目」。
import { createHash, randomBytes } from 'node:crypto'

/** まとめる項目の 1 つ */
export interface Topic {
  /** 項目の id。名前を変えても変えない */
  id: string
  name: string
  /** 何をまとめるか。要約する AI と、欄を選ぶ AI への手がかり（最後のチェックには渡さない） */
  guide: string
  /** ai: AI が要約して書く。machine: 機械で入れる（その日の日付） */
  by: 'ai' | 'machine'
  /** 最後に書く項目（全体のまとめ） */
  last: boolean
  /** machine の項目だけ。入れる欄（1 回目の欄、2 回目からの欄） */
  keys?: { first: string, later: string }
  /** 責任者の画面（AI 特訓部屋）で項目をまとめる区切りの名前（例: 基本情報・課題分析）。録音の処理は使わない */
  section?: string
}

/** 事業所が直した項目（office_topics の 1 行）。全体の一覧との差分だけ */
export interface OfficeTopics {
  /** 足した項目（AI がまとめる項目。最後に書く項目・機械の項目は足せない） */
  added: { id: string, name: string, guide: string }[]
  /** 項目の説明への書き足し（項目の id → 文。教えたことが複数あるときは 1 行に 1 つ）。全体の項目にも、足した項目にも書き足せる */
  notes: Record<string, string>
}

/**
 * 録音の処理が使う一覧: 全体の一覧に、事業所の書き足しと、足した項目を合わせる。
 * 書き足しは項目の説明のあとに足す（一覧から消えた項目への書き足しは使わない）。
 * 足した項目は、AI がまとめる全体の項目のあと、最後に書く項目と機械の項目の前に置く
 */
export function topicsFor(base: readonly Topic[], office?: OfficeTopics | null): Topic[] {
  if (!office) return base.map((t) => ({ ...t }))
  const join = (guide: string, note: string | undefined) => [guide.trim(), (note ?? '').trim()].filter(Boolean).join(' ')
  const merged = base.map((t) => ({ ...t, guide: join(t.guide, office.notes[t.id]) }))
  const ids = new Set(base.map((t) => t.id))
  const added: Topic[] = office.added.filter((t) => !ids.has(t.id)).map((t) => ({ id: t.id, name: t.name, guide: join(t.guide, office.notes[t.id]), by: 'ai', last: false }))
  const tail = merged.findIndex((t) => t.by !== 'ai' || t.last)
  if (tail < 0) return [...merged, ...added]
  return [...merged.slice(0, tail), ...added, ...merged.slice(tail)]
}

/** 使った一覧の指紋（事業所が直す前と後で、書き込みを比べられるように jobs.steps に残す） */
export function topicsFingerprint(topics: readonly Topic[]): string {
  const canon = topics.map((t) => [t.id, t.name, t.guide, t.by, t.last, t.keys?.first ?? null, t.keys?.later ?? null])
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16)
}

/** AI が要約する項目（機械の項目を除く。最後に書く項目も、話に出れば要約する） */
export const summaryTopics = (topics: readonly Topic[]) => topics.filter((t) => t.by === 'ai')

// ---------- 事業所が足した種類の項目（#153） ----------

/** 拾う内容の案を作る AI に渡すもの: 書類の名前と、書式の欄に入る内容の言葉 */
export interface TopicDraftInput { kindName: string, slots: string[] }
/** 案の 1 つ（名前と、何をまとめるか） */
export interface TopicDraft { name: string, guide: string }
export type TopicDrafter = (input: TopicDraftInput) => Promise<TopicDraft[]>

/** 足した種類の最後に書く項目。録音から書く種類は、はじめはこれだけを持つ（一覧が空なら録音から書かない） */
export const OFFICE_OVERALL: Topic = { id: 'overall', name: '全体のまとめ', guide: 'その回の話の全体のまとめ。ほかの項目に入らない大事な話も含める', by: 'ai', last: true }

/**
 * 責任者が直した項目の一覧を、保存する形にする。id のない項目には、重ならない id を振る。最後に書く項目（全体のまとめ）は最後に 1 つだけ残す
 */
export function officeTopics(items: readonly { id?: string, name: string, guide: string }[]): Topic[] {
  const used = new Set<string>(['overall'])
  const out: Topic[] = []
  for (const it of items) {
    let id = it.id && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(it.id) && !used.has(it.id) ? it.id : ''
    for (let n = out.length + 1; !id; n++) if (!used.has(`t${n}`)) id = `t${n}`
    used.add(id)
    out.push({ id, name: it.name.trim(), guide: it.guide.trim(), by: 'ai', last: false })
  }
  return [...out, { ...OFFICE_OVERALL }]
}

/** 試しの案（費用なし）: 書式の欄の言葉を、そのまま 1 つずつ項目にする（多すぎるときは先頭から 10 個） */
export const fakeTopicDrafter: TopicDrafter = async ({ slots }) =>
  [...new Set(slots.map((s) => s.trim()).filter(Boolean))].slice(0, 10).map((s) => ({ name: s, guide: `${s}について話に出たこと` }))

// ---------- 事業所が直せる項目（#115）: 責任者の AI 特訓部屋 ----------

/** 1 項目に書き足せる行の数と、1 行の長さ */
export const NOTE_LINES_MAX = 20
export const NOTE_LINE_MAX = 200

/** office_topics の 1 行（合格の印も含む） */
export interface OfficeTopicsRow extends OfficeTopics {
  /** 責任者が［合格］にした項目の id（特訓度のため。録音の処理は使わない） */
  passed: string[]
}

/** 責任者が送る直し（書き足しは行の配列。足した項目の id がなければ振る） */
export interface OfficeTopicsEdit {
  added: { id?: string, name: string, guide: string }[]
  notes: Record<string, string[]>
  passed: string[]
}

/** 書き足しの文を行に分ける（空の行は捨てる） */
export const noteLines = (note: string | undefined): string[] => (note ?? '').split('\n').map((s) => s.trim()).filter(Boolean)

/**
 * 責任者の直しを、保存する形にする。直せないもの（一覧にない項目・機械の項目への書き足し、全体の項目と同じ id の足し）は error を返す。
 * 全体の項目は、ここでは消すことも名前を変えることもできない（直しに全体の項目は入らない）
 */
export function editOfficeTopics(base: readonly Topic[], edit: OfficeTopicsEdit): { value?: OfficeTopicsRow, error?: string } {
  const baseIds = new Set(base.map((t) => t.id))
  const used = new Set(baseIds)
  const added: OfficeTopics['added'] = []
  for (const a of edit.added) {
    if (a.id && baseIds.has(a.id)) return { error: `全体の項目（${a.id}）は足せません` }
    // 新しい項目の id は乱数で振る（消した項目の id を使い回すと、前の要約が新しい項目のものになる）
    let id = a.id && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(a.id) && !used.has(a.id) ? a.id : ''
    while (!id) { const c = `o_${randomBytes(4).toString('hex')}`; if (!used.has(c)) id = c }
    used.add(id)
    added.push({ id, name: a.name.trim(), guide: a.guide.trim() })
  }
  const writable = new Set([...base.filter((t) => t.by === 'ai').map((t) => t.id), ...added.map((a) => a.id)])
  const notes: Record<string, string> = {}
  for (const [id, lines] of Object.entries(edit.notes)) {
    if (!writable.has(id)) return { error: `一覧にない項目（${id}）には書き足せません` }
    const kept = lines.flatMap((l) => noteLines(l))
    if (kept.length) notes[id] = kept.join('\n')
  }
  const known = new Set([...base.map((t) => t.id), ...added.map((a) => a.id)])
  const passed = [...new Set(edit.passed)].filter((id) => known.has(id))
  return { value: { added, notes, passed } }
}

/** AI 特訓部屋の 1 項目 */
export interface TrainingItem {
  id: string
  name: string
  /** 項目の説明（「ここには、録音からこれを書きます」）。書き足しは混ぜない */
  guide: string
  /** 教えたこと（書き足しの行） */
  notes: string[]
  /** standard: 全体の項目（消せない）。office: 事業所が足した書類の、AI が作った項目。added: 特訓部屋で足した項目 */
  origin: 'standard' | 'office' | 'added'
  removable: boolean
  passed: boolean
  section: string | null
}

/**
 * AI 特訓部屋に出す項目: AI がまとめる項目だけ（全体のまとめ・機械の項目は出さない）。
 * ownKind は事業所が足した書類（その一覧は AI が作ったものなので消せる）
 */
export function trainingItems(base: readonly Topic[], office: OfficeTopicsRow | null, opt: { ownKind: boolean }): TrainingItem[] {
  const passed = new Set(office?.passed ?? [])
  const notes = office?.notes ?? {}
  const ids = new Set(base.map((t) => t.id))
  const own: TrainingItem[] = base.filter((t) => t.by === 'ai' && !t.last).map((t) => ({
    id: t.id, name: t.name, guide: t.guide, notes: noteLines(notes[t.id]), origin: opt.ownKind ? 'office' : 'standard',
    removable: opt.ownKind, passed: passed.has(t.id), section: t.section ?? null,
  }))
  const added: TrainingItem[] = (office?.added ?? []).filter((a) => !ids.has(a.id)).map((a) => ({
    id: a.id, name: a.name, guide: a.guide, notes: noteLines(notes[a.id]), origin: 'added', removable: true, passed: passed.has(a.id), section: null,
  }))
  return [...own, ...added]
}

/** ダメ出しの振り分け（AI の答え） */
export type TeachDecision =
  /** その項目に 1 行書き足す */
  | { type: 'note', topicId: string, line: string }
  /** どの項目にも当てはまらないので、新しい項目を作る */
  | { type: 'new', name: string, guide: string }
  /** 意味が二通りに取れるので聞き返す（選んだら、その項目に書き足す） */
  | { type: 'ask', question: string, options: { label: string, topicId: string, line: string }[] }
  /** 話に出ていないことを書かせる頼みなどは断る */
  | { type: 'refuse', message: string }

export interface TeachInput {
  kindName: string
  items: { id: string, name: string, guide: string }[]
  /** 今見ている項目の id（どの項目も開いていなければ null） */
  current: string | null
  text: string
}
export type TopicTeacher = (input: TeachInput) => Promise<TeachDecision>

/** 新しい項目の名前（一言の頭から） */
const nameOf = (text: string) => text.trim().replace(/\s+/g, ' ').slice(0, 20)

/**
 * AI の振り分けを確かめる。一覧にない項目を指したら新しい項目にし、聞き返しの選択肢からない項目を外す（AI の答えをそのまま信じない）
 */
export function settleTeach(items: readonly { id: string }[], d: TeachDecision, text: string): TeachDecision {
  const ids = new Set(items.map((i) => i.id))
  const fresh = (line: string): TeachDecision => {
    const s = (line.trim() || text.trim()).slice(0, NOTE_LINE_MAX)
    return { type: 'new', name: nameOf(s), guide: s }
  }
  if (d.type === 'note') {
    const line = d.line.trim().slice(0, NOTE_LINE_MAX) || text.trim().slice(0, NOTE_LINE_MAX)
    return ids.has(d.topicId) ? { type: 'note', topicId: d.topicId, line } : fresh(d.line)
  }
  if (d.type === 'ask') {
    const options = d.options.filter((o) => ids.has(o.topicId) && o.line.trim()).map((o) => ({ label: o.label.trim(), topicId: o.topicId, line: o.line.trim().slice(0, NOTE_LINE_MAX) }))
    return options.length ? { type: 'ask', question: d.question.trim(), options } : fresh(text)
  }
  if (d.type === 'new') return { type: 'new', name: (d.name.trim() || nameOf(text)).slice(0, 40), guide: (d.guide.trim() || text.trim()).slice(0, 400) }
  return { type: 'refuse', message: d.message.trim() }
}

/**
 * 試しの振り分け（費用なし）。「それらしく」「推測」などは断る。項目を開いていればその項目に、
 * 開いていなければ名前が一言に入っている項目に足す（2 つ以上なら聞き返す）。どれにもなければ新しい項目
 */
export const fakeTopicTeacher: TopicTeacher = async ({ items, current, text }) => {
  const t = text.trim()
  if (/それらしく|推測|想像|適当に埋め/.test(t)) return { type: 'refuse', message: '話に出ていないことは書けません。録音で話に出たことだけを書きます。' }
  if (current) return { type: 'note', topicId: current, line: t }
  const hits = items.filter((i) => t.includes(i.name))
  if (hits.length === 1) return { type: 'note', topicId: hits[0].id, line: t }
  if (hits.length > 1) return { type: 'ask', question: 'どの項目のことですか？', options: hits.map((h) => ({ label: h.name, topicId: h.id, line: t })) }
  return { type: 'new', name: nameOf(t), guide: t }
}
