import { diagramSchema, diagramKinds, diagramDocument, nextDiagram } from '../../../core/diagram/fields.ts'
// 「書き方を相談する」の決めごと（画面の部品から分けて、テストで確かめる）。
// やり取りは画面の中だけで持つ（開き直すと消える）。書き換えの案は、ケアマネが押したときだけ用紙に入れる。
import type { ChatMessage, ChatProposal } from '../../../api/chat.ts'
import { sameValue } from '../../../core/apply-batch.ts'

/** ready: まだ入れていない／applied: 用紙に入れた（「戻す」ができる） */
export type CardState = 'ready' | 'applied'
export interface ProposalCard extends ChatProposal { state: CardState, superseded?: boolean, undone?: boolean }
/** steps: ペットが使った道具の作業ログ（1 行ずつ） */
export interface ChatEntry { id: number, role: ChatMessage['role'], text: string, steps?: string[], proposals?: ProposalCard[] }

/** Continue the selected figure's latest unapplied draft; never resurrect stale, applied or undone proposals. */
export function pendingDiagramDraft(entries: ChatEntry[], current: Record<string, unknown>, topic?: string): ProposalCard | undefined {
  for (const entry of entries.toReversed()) {
    const diagrams = entry.proposals?.filter((p) => p.key === 'family.genogram' || p.key === 'health.bodyMap') ?? []
    if (!diagrams.length) continue
    const card = topic ? diagrams.find((p) => p.key === topic) : diagrams.length === 1 ? diagrams[0] : undefined
    if (!card) { if (!topic) return; continue }
    return card.state === 'ready' && !card.superseded && !card.undone && sameValue(current[card.key], card.before) ? card : undefined
  }
}

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
