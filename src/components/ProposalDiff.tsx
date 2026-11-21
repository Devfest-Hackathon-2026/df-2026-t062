import type { FieldDict } from '../../core/dictionary.ts'
import { proposalChanges } from './petChat.ts'

/** 相談・添付取込で共通の比較表示。文章も選択式も、元の内容と提案の差分を出す。 */
export function ProposalDiff({ field, before, after, dict, unchanged }: { field: string, before: unknown, after: unknown, dict?: FieldDict, unchanged?: string }) {
  const { del, ins } = proposalChanges(field, before, after, dict)
  return <>
    {del.map((text, index) => <p key={`d${index}`} className="assistant-chat-del"><span aria-label="消える文">−</span>{text}</p>)}
    {ins.map((text, index) => <p key={`i${index}`} className="assistant-chat-ins"><span aria-label="足す文">＋</span>{text}</p>)}
    {!del.length && !ins.length && unchanged && <p>{unchanged}</p>}
  </>
}
