import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { diagramDocument, type DiagramValue } from '../../../core/diagram/fields.ts'
import { BODY_VIEWS, bodyAnchor, tapPosition } from '../../../core/diagram/body.ts'
import { drawingPoint } from '../../../core/diagram/interaction.ts'
import type { PendingLocation } from '../../../core/diagram/evidence.ts'
import type { Item } from '../../../core/diagram/model.ts'
import Preview from './Preview.tsx'
import './editor.css'
interface Props { value: DiagramValue, target: PendingLocation, onPlace: (item: Item) => void, onClose: () => void }
/** Only an explicitly selected symptom can be placed. No palette, drag or automatic insertion. */
export default function BodyPositionPicker({ value, target, onPlace, onClose }: Props) {
  const [view, setView] = useState<'front' | 'back' | null>(target.view ?? null)
  const [cursor, setCursor] = useState<{ x: number, y: number } | null>(null)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const figure = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number, y: number } | null>(null)
  const used = useRef(false)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => previous?.focus({ preventScroll: true })
  }, [])
  function place(at: { x: number, y: number }) {
    if (!view || used.current) return
    const position = tapPosition(view, at.x, at.y)
    if (!position) { setError('人体の部位がある範囲を選んでください'); return }
    used.current = true
    onPlace({ id: target.id, kind: target.kind, label: target.label, sources: target.sources, anatomy: { region: 'custom', side: 'unknown', view }, ...position })
    onClose()
  }
  function pointerUp(e: PointerEvent<HTMLDivElement>) {
    const down = start.current; start.current = null
    if (!view || !down || !e.isPrimary || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return
    const matrix = figure.current?.querySelector('svg')?.getScreenCTM()
    const at = matrix && drawingPoint({ x: e.clientX, y: e.clientY }, matrix)
    if (at) place(at)
  }
  return createPortal(<dialog ref={dialog} className="diagram-editor diagram-large body-position-dialog" aria-labelledby="body-position-title" onCancel={(e) => { e.preventDefault(); onClose() }}>
    <header><h2 id="body-position-title">{target.label}の場所を指定</h2><button type="button" onClick={onClose}>指定せず戻る</button></header>
    <p>左右はご本人を基準にします。正面・背面を選び、場所を一度押してください。</p>
    <div role="group" aria-label="人体の向き" className="diagram-toolbar">{(['front', 'back'] as const).map((v) => <button key={v} type="button" aria-pressed={view === v} onClick={() => { setView(v); setCursor(null); setError('') }}>{v === 'front' ? '正面' : '背面'}</button>)}</div>
    {view && <div ref={figure} className="body-position-figure" role="group" tabIndex={0} aria-label={`${view === 'front' ? '正面' : '背面'}の位置指定。矢印キーで場所を選び、Enterで指定。正面では本人の右は画面左、背面では画面右`} onPointerDown={(e) => { if (e.isPrimary && e.button === 0) start.current = { x: e.clientX, y: e.clientY } }} onPointerCancel={() => { start.current = null }} onPointerUp={pointerUp}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && cursor) { e.preventDefault(); place(cursor); return }
        const movement: Record<string, [number, number]> = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] }
        if (!movement[e.key]) return
        e.preventDefault()
        const [dx, dy] = movement[e.key], bounds = BODY_VIEWS[view]
        const at = cursor ?? bodyAnchor({ region: 'abdomen', side: 'midline', view })!
        setCursor({ x: Math.max(bounds.x, Math.min(bounds.x + bounds.width, at.x + dx)), y: Math.max(135, Math.min(525, at.y + dy)) })
      }}>
      <Preview doc={diagramDocument(value)} tab="body" bodyView={view} />
      {cursor && <span className="body-position-cursor" aria-hidden="true" style={{ left: `${(cursor.x - BODY_VIEWS[view].x) / BODY_VIEWS[view].width * 100}%`, top: `${cursor.y / 560 * 100}%` }}>＋</span>}
    </div>}
    <p role="status">{cursor ? '位置候補を選択中です。Enterで指定します。' : view ? '矢印キーとEnterでも位置を指定できます。' : '先に正面か背面を選んでください。'}</p>
    {error && <p role="alert">{error}</p>}
  </dialog>, document.body)
}
