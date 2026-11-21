import { lazy, Suspense, useState } from 'react'
import { diagramKinds, diagramSchema, type DiagramField } from '../../../core/diagram/fields.ts'
import type { DocState } from './useDocument.ts'
import type { SlotView } from './layout.ts'
import { pos } from './layout.ts'
import Preview from '../diagram/Preview.tsx'
import { diagramDocument } from '../../../core/diagram/fields.ts'
import '../diagram/editor.css'
const Editor = lazy(() => import('../diagram/DiagramFieldEditor.tsx'))
export default function DiagramSlot({ slot, state, disabled, onChat }: { slot: SlotView, state: DocState, disabled: boolean, onChat?: (key: string) => void }) {
  const [opened, setOpened] = useState<DiagramField | null>(null)
  const key = slot.binding!.ref.key
  const parsed = diagramSchema.safeParse(state.current[key])
  const value = parsed.success && parsed.data.kind === diagramKinds[key] ? parsed.data : null
  const invalid = state.current[key] != null && !value
  const chatOnly = key === 'family.genogram' || key === 'health.bodyMap'
  return <>
    <button type="button" disabled={disabled || invalid} className="diagram-slot" data-mark={state.marks.get(slot.name)} style={pos(slot.x, slot.y, slot.w, slot.h)} aria-label={`${slot.label}${chatOnly ? 'をチャットで作成・修正' : 'を編集する'}`} onClick={() => { if (chatOnly) onChat?.(key); else setOpened({ id: key, title: slot.label, kind: diagramKinds[key], value }) }}>
      {value && <Preview doc={diagramDocument(value)} tab={value.kind} cropBody />}
      <span>{invalid ? '図のデータを確認してください' : chatOnly ? onChat ? 'チャットで作成・修正' : 'PCの「書き方を相談する」で作成・修正' : value ? '図を確認・手直し' : '手動で補う'}</span>
    </button>
    {opened && !chatOnly && <Suspense fallback={<span role="status">図の編集画面を開いています…</span>}><Editor field={opened} onClose={() => setOpened(null)} onApply={(next, base) => state.applyDiagram(key, next, base)} /></Suspense>}
  </>
}
