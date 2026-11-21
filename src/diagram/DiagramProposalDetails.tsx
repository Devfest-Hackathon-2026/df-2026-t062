import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { diagramSchema, diagramDocument } from '../../core/diagram/fields.ts'
import { diagramChanges } from '../../core/diagram/changes.ts'
import type { Item } from '../../core/diagram/model.ts'
import type { PendingLocation } from '../../core/diagram/evidence.ts'
import type { ProposalCard } from '../components/petChat.ts'
import Preview from './Preview.tsx'
import './editor.css'
const PositionPicker = lazy(() => import('./BodyPositionPicker.tsx'))
export default function DiagramProposalDetails({ card, disabled, onChange }: { card: ProposalCard, disabled: boolean, onChange: (card: ProposalCard) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  const [target, setTarget] = useState<PendingLocation | null>(null)
  useEffect(() => {
    if (!target && wasOpen.current) root.current?.focus({ preventScroll: true })
    wasOpen.current = !!target
  }, [target])
  useEffect(() => { if (disabled) setTarget(null) }, [disabled])
  const parsed = diagramSchema.safeParse(card.after)
  if (!parsed.success) return <p role="alert">図の内容を表示できません</p>
  const value = parsed.data
  const changes = diagramChanges(card.before, card.after)
  const pending = card.pendingLocations ?? []
  function place(item: Item) {
    if (value.kind !== 'body') return
    onChange({ ...card, after: { ...value, data: { items: [...value.data.items.filter((i) => i.id !== item.id), item] } }, pendingLocations: pending.filter((p) => p.id !== item.id) })
  }
  return <div ref={root} className="diagram-proposal-details" tabIndex={-1} aria-label="図案の確認">
    <Preview doc={diagramDocument(value)} tab={value.kind} cropBody />
    <ul aria-label="図の変更内容">{changes.slice(0, 5).map((change) => <li key={change.id}>{change.text}</li>)}{pending.map((p) => <li key={p.id}>位置確認：{p.label}</li>)}</ul>
    {changes.length > 5 && <details><summary>残りの変更（{changes.length - 5}件）</summary><ul>{changes.slice(5).map((c) => <li key={c.id}>{c.text}</li>)}</ul></details>}
    {!!card.questions?.length && <div><strong>確認したいこと</strong><ul>{card.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
    {pending.length > 0 && card.state === 'ready' && <div className="diagram-location-requests"><p>場所を指定してから用紙に反映します。</p>{pending.map((p) => <button key={p.id} type="button" disabled={disabled} onClick={() => setTarget(p)}>{p.label}：図上で場所を指定</button>)}</div>}
    {target && <Suspense fallback={<p role="status">人体図を開いています…</p>}><PositionPicker value={value} target={target} onPlace={place} onClose={() => setTarget(null)} /></Suspense>}
  </div>
}
