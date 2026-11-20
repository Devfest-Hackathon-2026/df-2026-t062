import { sameValue } from '../../core/apply-batch.ts'
import { diagramSchema, diagramDocument, diagramKinds } from '../../core/diagram/fields.ts'
// 「書き方を相談する」: ペット（道具を使うエージェント）に書き方を相談する。したこと（作業ログ）を 1 行ずつ出す。書き換えの案は差分のカードで出し、押したときだけ用紙に入れる。
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type FormEvent, type KeyboardEvent, type SetStateAction } from 'react'
import { api } from '../lib/api.ts'
import { PetIcon, PetMessage } from './PetVisuals.tsx'
import { cardAction, diagramCardStatus, historyFor, proposalChanges, type ChatEntry, type ProposalCard } from './petChat.ts'

const DiagramProposalDetails = lazy(() => import('../diagram/DiagramProposalDetails.tsx'))
const Preview = lazy(() => import('../diagram/Preview.tsx'))

interface Props {
  diagramRequest?: { key: string, id: number }
  saved?: Record<string, unknown>
  documentId: string | undefined
  entries: ChatEntry[]
  setEntries: Dispatch<SetStateAction<ChatEntry[]>>
  /** 用紙の今の値（画面で直したばかりの値を含む） */
  current: Record<string, unknown>
  onSet: (key: string, value: unknown, mode: 'edit' | 'revert') => void
  onDiagramApply?: (key: string, value: unknown, base: unknown) => Promise<void>
  /** 用紙のその欄へ移る。移れない書類では undefined */
  onJump?: (key: string) => void
}

let nextId = 1

function DiffLines({ field, before, after }: { field: string, before: unknown, after: unknown }) {
  if (diagramKinds[field]) {
    const b = diagramSchema.safeParse(before), a = diagramSchema.safeParse(after)
    return <Suspense fallback={<p>図を読み込んでいます…</p>}><div>{b.success && <><p>変更前</p><Preview doc={diagramDocument(b.data)} tab={b.data.kind} cropBody /></>}{a.success && <><p>変更案</p><Preview doc={diagramDocument(a.data)} tab={a.data.kind} cropBody /></>}</div></Suspense>
  }
  const { del, ins } = proposalChanges(field, before, after)
  return (
    <>
      {del.map((t, i) => <p key={`d${i}`} className="assistant-chat-del"><span aria-label="消える文">−</span>{t}</p>)}
      {ins.map((t, i) => <p key={`i${i}`} className="assistant-chat-ins"><span aria-label="足す文">＋</span>{t}</p>)}
    </>
  )
}

export function PetChat({ documentId, entries, setEntries, current, onSet, onDiagramApply, onJump, saved = {}, diagramRequest }: Props) {
  const applyingRef = useRef(false)
  const [applying, setApplying] = useState(false)
  const [text, setText] = useState('')
  const [revisionDraft, setRevisionDraft] = useState<ProposalCard>()
  const input = useRef<HTMLTextAreaElement>(null)
  const requestSeen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!diagramRequest || requestSeen.current === diagramRequest.id) return
    requestSeen.current = diagramRequest.id
    setText(current[diagramRequest.key] ? `${diagramRequest.key === 'family.genogram' ? '家族構成図' : '身体図'}を修正したい：` : diagramRequest.key === 'family.genogram' ? '訪問記録と既存書類から家族構成図を作成して' : '訪問記録と既存書類から身体図を作成して')
    setRevisionDraft(undefined)
    input.current?.focus({ preventScroll: true })
  }, [diagramRequest])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stale, setStale] = useState<Set<string>>(new Set())
  /** 答えを待つ間に届いた作業ログ（届くたびに 1 行ずつ出す） */
  const [live, setLive] = useState<string[]>([])
  const root = useRef<HTMLDivElement>(null)
  const activeDoc = useRef(documentId)
  activeDoc.current = documentId

  // 送ったとき・答えが来たときは、ペット欄をいちばん下まで送る（入力欄は下に固定なので、最新の吹き出しがその上に見える）。
  // scrollIntoView は外側の枠まで動かし、吹き出しが入力欄の裏に隠れるので使わない
  useLayoutEffect(() => {
    const box = root.current?.closest('.assistant-body')
    if (box) box.scrollTop = box.scrollHeight
  }, [entries.length, busy, error, live.length])

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    const question = text.trim()
    if (!question || busy || !documentId) return
    const asked: ChatEntry = { id: nextId++, role: 'user', text: question }
    const history = historyFor([...entries, asked])
    setEntries((prev) => [...prev, asked])
    setText('')
    setError('')
    setLive([])
    setBusy(true)
    try {
      const r = await api.chat(documentId, history, (s) => { if (activeDoc.current === documentId) setLive((prev) => [...prev, s]) }, revisionDraft ? { key: revisionDraft.key, after: revisionDraft.after, pendingLocations: revisionDraft.pendingLocations } : undefined)
      if (activeDoc.current !== documentId) return
      setRevisionDraft(undefined)
      setEntries((prev) => [...prev.map((entry) => ({ ...entry, proposals: entry.proposals?.map((p) => p.state === 'ready' && r.proposals.some((next) => next.key === p.key) ? { ...p, superseded: true } : p) })), { id: nextId++, role: 'pet', text: r.reply, steps: r.steps, proposals: r.proposals.map((p) => ({ ...p, state: 'ready' })) }])
    } catch {
      if (activeDoc.current !== documentId) return
      // 送れなかった相談は入力欄に戻す
      setEntries((prev) => prev.filter((x) => x.id !== asked.id))
      setText(question)
      setError('ペットに相談できませんでした。少し待ってから、もう一度送ってください。')
    } finally {
      if (activeDoc.current === documentId) { setBusy(false); setLive([]) }
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 日本語の変換中の Enter は送らない。送るのは Ctrl／⌘＋Enter
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) void send()
  }

  const press = async (entryId: number, card: ProposalCard) => {
    if (applyingRef.current || card.superseded || card.state === 'ready' && card.pendingLocations?.length) return
    const startedDoc = documentId
    const id = `${entryId}:${card.key}`
    const a = cardAction(card, current[card.key])
    if (a.kind === 'stale') {
      setStale((prev) => new Set(prev).add(id))
      return
    }
    setError('')
    if (diagramKinds[card.key]) {
      if (!onDiagramApply) { setError('この画面からは図を反映できません。'); return }
      applyingRef.current = true
      setApplying(true)
      try {
        await onDiagramApply(card.key, a.value, current[card.key] ?? null)
        if (activeDoc.current !== startedDoc) return
      } catch (e) {
        if (activeDoc.current === startedDoc) setError(e instanceof Error ? e.message : '図を反映できませんでした。')
        return
      } finally { applyingRef.current = false; setApplying(false) }
    } else onSet(card.key, a.value, card.state === 'ready' ? 'edit' : 'revert')
    setStale((prev) => { const next = new Set(prev); next.delete(id); return next })
    setEntries((prev) => prev.map((x) => (x.id !== entryId ? x : { ...x, proposals: x.proposals?.map((p) => (p.key === card.key ? { ...p, state: a.next, ...(diagramKinds[p.key] ? { undone: a.next === 'ready' } : {}), ...(diagramKinds[p.key] ? a.next === 'applied' ? { after: a.value } : { before: a.value } : {}) } : p)) })))
  }

  return (
    <div ref={root} className="assistant-chat">
      <PetMessage>用紙の文章や図を相談できます。家族図・身体図の作成や訂正も、ここに書いてください。</PetMessage>
      <ol className="assistant-chat-log" aria-live="polite">
        {entries.map((m) => (
          <li key={m.id} className={`assistant-chat-row assistant-chat-${m.role}`}>
            {!!m.steps?.length && (
              <ul className="assistant-chat-steps" aria-label="ペットがしたこと">
                {m.steps.map((s, i) => <li key={i}><PetIcon name="check2" />{s}</li>)}
              </ul>
            )}
            <p className="assistant-chat-bubble">{m.text}</p>
            {m.proposals?.map((card) => {
              const id = `${m.id}:${card.key}`
              return (
                <div key={card.key} className="assistant-chat-card" data-state={card.state}>
                  {onJump
                    ? <button type="button" className="assistant-chat-field" onClick={() => onJump(card.key)}>{card.label}<PetIcon name="chevron-right" /></button>
                    : <strong className="assistant-chat-field">{card.label}</strong>}
                  {['family.genogram', 'health.bodyMap'].includes(card.key) ? <Suspense fallback={<p>図を読み込んでいます…</p>}><DiagramProposalDetails card={card} disabled={applying || !!card.superseded} onChange={(next) => setEntries((prev) => prev.map((entry) => entry.id !== m.id ? entry : { ...entry, proposals: entry.proposals?.map((p) => p.key === card.key && p.state === 'ready' && !p.superseded && sameValue(p.after, card.after) ? next : p) }))} /></Suspense> : <DiffLines field={card.key} before={card.before} after={card.after} />}
                  {!!diagramKinds[card.key] && <p role="status">{diagramCardStatus(card, current[card.key], saved[card.key])}</p>}
                  <div className="assistant-chat-actions">
                    {card.state === 'ready'
                      ? <button type="button" className="assistant-chat-apply" disabled={applying || !!card.superseded || !!card.pendingLocations?.length} onClick={() => void press(m.id, card)}><PetIcon name="pencil" />{diagramKinds[card.key] ? '用紙に反映' : '用紙に入れる'}</button>
                      : <>
                        <span className="assistant-chat-done"><PetIcon name="check2" />反映しました</span>
                        <button type="button" className="assistant-chat-undo" disabled={applying} onClick={() => void press(m.id, card)}>{diagramKinds[card.key] ? 'この案を一括で戻す' : '戻す'}</button>
                      </>}
                    {['family.genogram', 'health.bodyMap'].includes(card.key) && !card.superseded && <button type="button" disabled={applying || busy} onClick={() => { setRevisionDraft(card); setText('この図案を修正して：'); input.current?.focus({ preventScroll: true }) }}>この案を修正</button>}
                  </div>
                  {stale.has(id) && <p className="assistant-error" role="alert">{card.state === 'ready' ? '案を出したあとに、この欄が直されています。もう一度相談してください。' : '入れたあとに、この欄が直されているので戻せません。用紙で直してください。'}</p>}
                </div>
              )
            })}
          </li>
        ))}
        {busy && (
          <li className="assistant-chat-row assistant-chat-pet">
            {!!live.length && (
              <ul className="assistant-chat-steps" aria-label="ペットがしていること">
                {live.map((s, i) => <li key={i}><PetIcon name="check2" />{s}</li>)}
              </ul>
            )}
            <p className="assistant-chat-bubble assistant-chat-thinking"><span className="assistant-spinner" aria-hidden="true" />{live.length ? '調べています…' : '考えています…'}</p>
          </li>
        )}
      </ol>
      {error && <p className="assistant-error" role="alert">{error}</p>}
      {revisionDraft && <p role="status">{revisionDraft.label}の案を修正します。<button type="button" onClick={() => setRevisionDraft(undefined)}>修正対象を解除</button></p>}
      <form className="assistant-chat-form" onSubmit={send}>
        <textarea ref={input} className="assistant-revision" aria-label="相談内容" placeholder={documentId ? '相談したい内容を入力…（Ctrl＋Enter で送る）' : '用紙を開くと相談できます'}
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} disabled={!documentId} maxLength={4000} rows={3} />
        <button type="submit" className="assistant-primary" disabled={!documentId || busy || !text.trim()}>送る</button>
      </form>
    </div>
  )
}
