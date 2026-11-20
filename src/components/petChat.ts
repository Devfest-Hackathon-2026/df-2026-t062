import { diagramSchema, diagramKinds, diagramDocument, nextDiagram } from '../../core/diagram/fields.ts'
// 「書き方を相談する」の決めごと（画面の部品から分けて、テストで確かめる）。
// やり取りは画面の中だけで持つ（開き直すと消える）。書き換えの案は、ケアマネが押したときだけ用紙に入れる。
import type { ChatMessage, ChatProposal } from '../../api/chat.ts'
import { splitSentences } from '../../core/diff.ts'
import { BY_KEY, subFieldsOf, type FieldSpec } from '../../core/fields.ts'
import { sameValue } from '../../core/apply-batch.ts'

/** ready: まだ入れていない／applied: 用紙に入れた（「戻す」ができる） */
export type CardState = 'ready' | 'applied'
export interface ProposalCard extends ChatProposal { state: CardState, superseded?: boolean, undone?: boolean }
/** steps: ペットが使った道具の作業ログ（1 行ずつ） */
export interface ChatEntry { id: number, role: ChatMessage['role'], text: string, steps?: string[], proposals?: ProposalCard[] }

export function diagramCardStatus(card: ProposalCard, current: unknown, saved: unknown): string {
  if (card.superseded) return '新しい案を確認してください。'
  if (card.state === 'ready') {
    if (card.undone) return !sameValue(current, card.before) ? 'この案を戻したあとに、用紙が変更されています。' : sameValue(saved, current) ? '取り消した状態も保存版に確定済みです。' : '取り消しを用紙に反映済み・未保存です。保存すると確定します。'
    return '未反映の案です。'
  }
  if (!sameValue(current, card.after)) return 'この案の反映後に、用紙が変更されています。'
  return sameValue(saved, card.after) ? '用紙に反映し、保存版にも確定済みです。' : '用紙に反映済み・未保存です。書類またはページの「保存」で確定します。'
}

/** サーバーに送るやり取りの数（API の上限と同じ） */
export const MAX_HISTORY = 40

/**
 * カードのボタン（「用紙に入れる」／「戻す」）を押したときにすること。
 * 案を出したあと（入れたあと）にケアマネが欄を直していたら、上書きせずに知らせる。
 */
export function cardAction(card: ProposalCard, current: unknown): { kind: 'set', value: unknown, next: CardState } | { kind: 'stale' } {
  // まとまりの欄は、項目の並び（DB で並べ替わる）と空の項目を見ずに比べる
  const expected = card.state === 'ready' ? card.before : card.after
  if (!sameValue(current, expected)) return { kind: 'stale' }
  let value = card.state === 'ready' ? card.after : card.before ?? null
  if (diagramKinds[card.key]) {
    const now = diagramSchema.safeParse(current)
    const target = diagramSchema.safeParse(value)
    value = nextDiagram(diagramKinds[card.key], diagramDocument(target.success ? target.data : null), now.success ? now.data.revision : 0)
  }
  return { kind: 'set', value, next: card.state === 'ready' ? 'applied' : 'ready' }
}

/** サーバーに送るやり取り（文だけ、古い順、最後の MAX_HISTORY 件） */
export function historyFor(entries: ChatEntry[]): ChatMessage[] {
  return entries.slice(-MAX_HISTORY).map(({ role, text }) => ({ role, text: text.slice(0, 4000) }))
}

/** 案のカードに出す差分。文の途中で切らずに、前にだけある文（消える）と、新しい方にだけある文（足す）を出す */
export function sentenceChanges(before: string | null, after: string): { del: string[], ins: string[] } {
  const b = splitSentences(before ?? '').map((x) => x.trim()).filter(Boolean)
  const a = splitSentences(after).map((x) => x.trim()).filter(Boolean)
  return { del: b.filter((x) => !a.includes(x)), ins: a.filter((x) => !b.includes(x)) }
}

const blank = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

function shown(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ'
  if (Array.isArray(v)) return v.map(shown).join('、')
  if (v && typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** まとまりの値を「項目の名前：値」の行にする（表は「n 行目」を前に付ける） */
function lines(f: FieldSpec, v: unknown): string[] {
  if (blank(v)) return []
  const subs = subFieldsOf(f)
  const row = (r: unknown, head: string) => subs.flatMap((s) => {
    const x = (r as Record<string, unknown> | null)?.[s.key]
    return blank(x) ? [] : [`${head}${s.label}：${shown(x)}`]
  })
  if (f.type === 'object') return row(v, '')
  if (f.type === 'list' && Array.isArray(v)) return v.flatMap((r, i) => row(r, `${i + 1} 行目 `))
  return [shown(v)]
}

/** 案のカードに出す差分。文章の欄は文ごと、ほかの欄は「項目の名前：値」の行ごとに、消えるものと足すものを出す */
export function proposalChanges(key: string, before: unknown, after: unknown): { del: string[], ins: string[] } {
  const f = BY_KEY.get(key)
  if (!f || f.type === 'text' || f.type === 'longtext') return sentenceChanges(typeof before === 'string' ? before : null, typeof after === 'string' ? after : '')
  const b = lines(f, before)
  const a = lines(f, after)
  return { del: b.filter((x) => !a.includes(x)), ins: a.filter((x) => !b.includes(x)) }
}
