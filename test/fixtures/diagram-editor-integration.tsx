import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import DiagramFieldEditor from '../../src/components/diagram/DiagramFieldEditor.tsx'
import { blank } from '../../core/diagram/model.ts'
import { nextDiagram, type DiagramField, type DiagramValue } from '../../core/diagram/fields.ts'

// Memory-only harness for the two PRs sharing the editor. No API or model calls.
function Harness() {
  const [field, setField] = useState<DiagramField>()
  const [applied, setApplied] = useState<DiagramValue>()
  return <>
    <button onClick={() => {
      const doc = blank()
      doc.family.people = [{ id: 'subject', name: '架空本人', sex: 'female', household: '同居', deceased: null, x: 0, y: 0 }]
      setField({ id: 'family.genogram', title: '家族図', kind: 'family', value: nextDiagram('family', doc, 0) })
    }}>家族図を開く</button>
    <button onClick={() => setField({ id: 'house.layout', title: '家屋図', kind: 'house', value: null })}>家屋図を開く</button>
    {field && <DiagramFieldEditor field={field} onClose={() => setField(undefined)} onApply={async value => setApplied(value)} />}
    <output aria-label="反映した図">{JSON.stringify(applied)}</output>
  </>
}
createRoot(document.getElementById('root')!).render(<Harness />)
