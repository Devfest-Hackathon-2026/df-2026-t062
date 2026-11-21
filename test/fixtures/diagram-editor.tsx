// Isolated manual QA harness. Uses memory only; never represents database persistence.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import Editor from '../../src/diagram/DiagramFieldEditor.tsx'
import Preview from '../../src/diagram/Preview.tsx'
import { diagramKinds, diagramDocument, type DiagramField, type DiagramValue } from '../../core/diagram/fields.ts'
function Harness() {
  const [values, setValues] = useState<Record<string, DiagramValue>>({})
  const [opened, setOpened] = useState<DiagramField | null>(null)
  const [fail, setFail] = useState(false)
  return <main style={{ fontFamily: 'sans-serif', padding: 20 }}><h1>図エディタ操作検証</h1><p>検証用メモリーにだけ反映します。データベースへの保存は検証しません。</p><label><input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} />反映時の失敗を再現</label>{Object.entries(diagramKinds).map(([id, kind]) => <section key={id}><h2>{id}</h2><button onClick={() => setOpened({ id, kind, title: ({ house: '家屋見取図', family: '家族構成図', body: '障害等の部位' })[kind], value: values[id] ?? null })}>{kind}を開く</button><output aria-label={`${kind}の版`}>{values[id]?.revision ?? 0}</output><div style={{ maxWidth: 400 }}>{values[id] && <Preview doc={diagramDocument(values[id])} tab={kind} />}</div></section>)}{opened && <Editor field={opened} onClose={() => setOpened(null)} onApply={async (value) => { if (fail) throw new Error('検証用の保存失敗'); setValues({ ...values, [opened.id]: value }) }} />}</main>
}
createRoot(document.getElementById('root')!).render(<Harness />)
