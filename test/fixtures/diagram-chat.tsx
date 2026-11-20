import { PetHelper } from '../../src/components/PetHelper.tsx'
// UI-only harness: synthetic proposals, memory-only apply, explicit failure injection. No real patient or AI calls.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PetChat } from '../../src/components/PetChat.tsx'
import type { ChatEntry } from '../../src/components/petChat.ts'
import DiagramSlot from '../../src/diagram/DiagramSlot.tsx'
import type { DocState } from '../../src/form/useDocument.ts'
import type { SlotView } from '../../src/form/layout.ts'
import { blank } from '../../core/diagram/model.ts'
import { diagramSchema, nextDiagram, validDiagramUpdate } from '../../core/diagram/fields.ts'
import { sameValue } from '../../core/apply-batch.ts'
import { normalizeBodyProposal } from '../../core/diagram/body.ts'
import '../../src/components/PetHelper.css'
const d = blank()
d.family.people = [ { id: 'subject', name: '検証本人', sex: 'unknown', deceased: null, household: '同居', isSubject: true, x: 0, y: 0 }, { id: 'son', name: '検証長男', sex: 'male', deceased: null, household: '同居', x: 200, y: 0 } ]
d.family.relations = [{ id: 'relation', source: 'subject', target: 'son', kind: '親子' }]
const family = nextDiagram('family', d, 0)
d.family.people[1].household = '別居'
const familyAfter = nextDiagram('family', d, 1)
const body = diagramSchema.parse(normalizeBodyProposal({ version: 1, kind: 'body', revision: 1, data: { items: [{ id: 'known', kind: 'note', label: '左手のしびれ（検証）', x: 0, y: 0, width: 32, height: 52, rotation: 0, view: 'front', anatomy: { region: 'hand', side: 'left', view: 'front' } }] } }))
const source = { id: 'message:fixture', type: 'message' as const, label: '架空の検証用指示', quote: '長男は別居です。体のどこかが痛いので場所を図で指定します。' }
const initial: ChatEntry[] = [
  { id: 100, role: 'pet', text: '長男だけを別居に変更する案です。', proposals: [{ key: 'family.genogram', label: '家族構成図', before: family, after: familyAfter, state: 'ready', evidence: [{ objectId: 'son', sources: [source] }] }] },
  { id: 101, role: 'pet', text: '既存のしびれを残し、痛みの場所を確認する案です。', proposals: [{ key: 'health.bodyMap', label: '身体図', before: body, after: { ...body, revision: 2 }, state: 'ready', pendingLocations: [{ id: 'pending', kind: 'pain', label: '場所を確認したい痛み（検証）', sources: [source] }], evidence: [{ objectId: 'pending', sources: [source] }] }] },
]
function Harness() {
  const [entries, setEntries] = useState(initial)
  const [values, setValues] = useState<Record<string, unknown>>({ 'family.genogram': family, 'health.bodyMap': body })
  const [saved, setSaved] = useState<Record<string, unknown>>(values)
  const [fail, setFail] = useState(false)
  const [request, setRequest] = useState<{ key: string, id: number }>()
  async function apply(key: string, value: unknown, base: unknown) {
    if (fail) throw new Error('検証用の通信エラー。案は保持されています。')
    if (!sameValue(values[key], base) || !validDiagramUpdate(key, value, base)) throw new Error('検証用の競合')
    setValues((previous) => ({ ...previous, [key]: value }))
  }
  const state = { current: values, saved, marks: new Map(), doc: { id: 'fixture' }, applyDiagram: apply } as unknown as DocState
  const slot = (key: string, label: string): SlotView => ({ name: key, label, kind: 'diagram', x: 0, y: 0, w: 210, h: 297, pt: 12, lh: 1.1, align: 'left', binding: { op: 'diagram@1', ui: 'diagram', ref: { key } } })
  return <main style={{ fontFamily: 'sans-serif', color: '#151127', padding: 16 }}><h1>図のチャットUI検証</h1><p>架空の案をメモリーだけで操作する確認画面です。DB保存・実AIへの送信は行いません。</p><label><input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} />反映の通信エラーを再現</label><button type="button" onClick={() => setSaved(values)}>検証メモリーの保存版に確定</button>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 600px) minmax(330px, 440px)', gap: 24, maxWidth: 1100 }}>
      <section aria-label="図欄の確認">{[['family.genogram', '家族構成図'], ['health.bodyMap', '身体図']].map(([key, label]) => <div key={key}><h2>{label}</h2><div style={{ position: 'relative', width: 270, height: 200 }}><DiagramSlot slot={slot(key, label)} state={state} disabled={false} onChat={(key) => setRequest({ key, id: Date.now() })} /></div></div>)}</section>
      {new URLSearchParams(location.search).has('entry') ? <div style={{ height: '85vh', display: 'grid' }}><PetHelper available clientName="検証本人" review={[]} topics={[]} onJump={() => true} onPreview={() => 0} onIdentity={() => {}} verifiedSources={new Set()} diagramRequest={request} chat={{ documentId: 'fixture', current: values, saved, onSet: () => {}, onDiagramApply: apply }} /></div> : <aside className="assistant-panel" style={{ height: '85vh' }}><div className="assistant-body"><h2>書き方を相談する</h2><PetChat documentId="fixture" diagramRequest={request} current={values} saved={saved} entries={entries} setEntries={setEntries} onSet={() => {}} onDiagramApply={apply} /></div></aside>}
    </div>
  </main>
}
const root = createRoot(document.getElementById('root')!)
root.render(<Harness />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
