import { useEffect, useRef, useState } from 'react'
import type { CareRecordDraftView } from '../../../core/care-record.ts'
import { api } from '../../lib/api.ts'
import { chatErrorFromCode } from '../../../core/chat-error.ts'
import { PetMessage } from '../pet/PetVisuals.tsx'
import { ProposalDiff } from '../document/ProposalDiff.tsx'

export function CareRecordDraftPanel({ documentId, beforeAdopt, onApplied }: { documentId: string, beforeAdopt: () => Promise<boolean>, onApplied: () => Promise<void> }) {
  const [drafts, setDrafts] = useState<CareRecordDraftView[]>([])
  const [selected, setSelected] = useState('')
  const [instructions, setInstructions] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const acting = useRef(false)
  const request = useRef<{ id: string, instructions: string } | undefined>(undefined)
  const active = useRef(true)
  const draft = drafts.find(d => d.id === selected) ?? drafts[0]
  const generating = drafts.some(d => d.status === 'generating')
  useEffect(() => { active.current = true; api.careRecordDrafts(documentId).then(r => { if (active.current) setDrafts(r.drafts) }, () => { if (active.current) setError('AI下書きを取得できませんでした。') }); return () => { active.current = false } }, [documentId])
  useEffect(() => {
    if (!generating) return
    const timer = setInterval(() => { api.careRecordDrafts(documentId).then(r => { if (active.current) setDrafts(r.drafts) }, () => {}) }, 2000)
    return () => clearInterval(timer)
  }, [documentId, generating])
  const run = async (work: () => Promise<void>) => {
    if (acting.current) return
    acting.current = true; setBusy(true); setError('')
    try { await work() } catch (e) { if (active.current) setError(e instanceof Error ? e.message : '下書きを処理できませんでした。記録は変更していません。') }
    finally { acting.current = false; if (active.current) setBusy(false) }
  }
  const generate = () => void run(async () => {
    if (!await beforeAdopt()) return
    if (!request.current || request.current.instructions !== instructions) request.current = { id: crypto.randomUUID(), instructions }
    const r = await api.createCareRecordDraft(documentId, request.current.id, instructions)
    if (!active.current) return
    request.current = undefined
    setDrafts(rows => [r.draft, ...rows.filter(d => d.id !== r.draft.id)])
    setSelected(r.draft.id)
  })
  const adopt = () => void run(async () => {
    if (!draft || !await beforeAdopt()) return
    const r = await api.applyCareRecordDraft(documentId, draft.id)
    if (!active.current) return
    setDrafts(rows => rows.map(d => d.id === r.draft.id ? r.draft : d))
    await onApplied()
  })
  return <section className="care-record-draft" aria-label="支援経過のAI下書き">
    <h2>AI下書き</h2>
    <PetMessage>保存済みの書類や録音から、記録の下書きを作れます。日時は確認して入力してください。</PetMessage>
    <label>下書きへの補足<textarea aria-label="下書きへの補足" value={instructions} rows={2} maxLength={4000} onChange={e => setInstructions(e.target.value)} disabled={busy || generating} /></label>
    <button className="btn" disabled={busy || generating} onClick={generate}>資料から下書きを作る</button>
    {(busy || generating) && <p role="status">下書きを処理しています。記録の入力は続けられます。</p>}
    {error && <p role="alert" className="care-record-error">{error}</p>}
    {drafts.length > 1 && <label>最近のAI下書き<select value={draft?.id ?? ''} onChange={e => setSelected(e.target.value)} disabled={busy}>{drafts.map(d => <option key={d.id} value={d.id}>{new Date(d.capturedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ・ {d.appliedAt ? '採用済み' : d.status === 'failed' ? '失敗' : '未確認'}</option>)}</select></label>}
    {draft?.status === 'failed' && <p role="status">{draft.errorCode === 'not_configured' ? 'AI接続が未設定です。手入力で記録できます。' : chatErrorFromCode(draft.errorCode).message}</p>}
    {draft?.status === 'ready' && <div>
      <p role="status">{draft.appliedAt ? '採用済み。記録の保存は別に行ってください。' : '未確認の候補です。採用するまで記録は変わりません。'}</p>
      <small>参照：保存版 {draft.documentSources.length}件・録音 {draft.recordingSources.length}件 ／ {new Date(draft.capturedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</small>
      {draft.proposals.map(p => <div key={p.key}><h3>{p.label}</h3><ProposalDiff field={p.key} before={p.before} after={p.after} /></div>)}
      {draft.guidance && <p style={{ whiteSpace: 'pre-wrap' }}>{draft.guidance}</p>}
      {!draft.appliedAt && draft.proposals.length > 0 && <button className="btn" disabled={busy} onClick={adopt}>内容を確認して記録に採用</button>}
    </div>}
  </section>
}
