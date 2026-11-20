import { drawingPoint, contains } from '../../core/diagram/interaction.ts'
import { roomsBehind } from '../../core/diagram/svg.ts'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { diagramDocument, nextDiagram, type DiagramField, type DiagramValue } from '../../core/diagram/fields.ts'
import { labels, removePerson, uid, schema, type Doc, type Item, type Person, type Relation } from '../../core/diagram/model.ts'
import Preview from './Preview.tsx'
import ObjectThumbnail from './ObjectThumbnail.tsx'
import usePaletteDrag, { type PaletteObject } from './usePaletteDrag.tsx'
import './editor.css'

/** Field-only contract: page positions and persistence belong to the sheet adapter. */
export interface DiagramFieldEditorProps {
  field: DiagramField
  onApply: (value: DiagramValue, base: DiagramValue | null) => Promise<void>
  onClose: () => void
}
export default function DiagramFieldEditor({ field, onApply, onClose }: DiagramFieldEditorProps) {
  const [history, setHistory] = useState<Doc[]>(() => [diagramDocument(field.value)])
  const [index, setIndex] = useState(0)
  const [selected, select] = useState('')
  const [palette, setPalette] = useState(false)
  const [pendingBody, setPendingBody] = useState<Item['kind'] | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [large, setLarge] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [relation, setRelation] = useState({ source: '', target: '', kind: '婚姻' as Relation['kind'] })
  const root = useRef<HTMLDialogElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string, x: number, y: number, doc: Doc, moved: boolean } | null>(null)
  const [moving, setMoving] = useState<Doc | null>(null)
  const doc = moving ?? history[index]
  const family = field.kind === 'family'
  const objects = family ? doc.family.people : doc[field.kind as 'house' | 'body'].items
  const object = objects.find((o) => o.id === selected)
  const person = family ? object as Person | undefined : undefined
  const item = family ? undefined : object as Item | undefined
  const changed = JSON.stringify(doc) !== JSON.stringify(diagramDocument(field.value))
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    root.current?.showModal()
    return () => previous?.focus({ preventScroll: true })
  }, [])
  function commit(next: Doc) {
    const valid = schema.safeParse(next)
    if (!valid.success) { setError(valid.error.issues[0]?.message ?? '図の内容を確認してください'); return }
    if (JSON.stringify(history[index]) === JSON.stringify(next)) return
    const entries = [...history.slice(0, index + 1), valid.data].slice(-41)
    setHistory(entries); setIndex(entries.length - 1); setMoving(null); setError('')
  }
  function editObject(patch: Partial<Item & Person>, source = doc) {
    if (family) return { ...source, family: { ...source.family, people: source.family.people.map((p) => p.id === selected ? { ...p, ...patch } : p) } }
    const kind = field.kind as 'house' | 'body'
    return { ...source, [kind]: { ...source[kind], items: source[kind].items.map((p) => p.id === selected ? { ...p, ...patch } : p) } }
  }
  function point(client: { x: number, y: number }) {
    const svg = canvas.current?.querySelector('svg')
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return null
    return drawingPoint(client, matrix)
  }
  function add(object: PaletteObject, at = { x: 300, y: 220 }) {
    const id = uid()
    if ('sex' in object) {
      const person: Person = { id, sex: object.sex, name: '', household: '不明', deceased: false, x: Math.min(700, at.x), y: Math.min(450, at.y) }
      commit({ ...doc, family: { ...doc.family, people: [...doc.family.people, person] } })
    } else {
      const body = field.kind === 'body'
      const item: Item = { id, kind: object.kind, label: labels[object.kind], x: Math.min(780, at.x), y: Math.min(520, at.y), width: object.kind === 'room' ? 200 : 80, height: object.kind === 'room' ? 160 : 60, rotation: 0, ...(body ? { view: at.x < 410 ? 'front' as const : 'back' as const } : {}) }
      const kind = field.kind as 'house' | 'body'
      commit({ ...doc, [kind]: { ...doc[kind], items: [...doc[kind].items, item] } })
    }
    select(id); setPendingBody(null)
  }
  const paletteDrag = usePaletteDrag((object, client) => { const at = point(client); if (at) add(object, at) })
  function close() { if (!busy && (!changed || window.confirm('この図の変更を破棄して戻りますか？'))) onClose() }
  function pointerDown(e: PointerEvent<HTMLDivElement>) {
    if (busy || confirm || !e.isPrimary || e.button !== 0) return
    const at = point({ x: e.clientX, y: e.clientY }); if (!at) return
    if (pendingBody) { add({ kind: pendingBody }, at); return }
    // Rooms are always behind other objects, including hit testing.
    const ordered = family ? objects : roomsBehind(objects as Item[])
    const hit = [...ordered].reverse().find((o) => contains(o, at))
    select(hit?.id ?? '')
    if (hit) { drag.current = { id: hit.id, x: at.x, y: at.y, doc: history[index], moved: false }; e.currentTarget.setPointerCapture(e.pointerId) }
  }
  function pointerMove(e: PointerEvent<HTMLDivElement>) {
    const g = drag.current; if (!g || busy || confirm) return
    const at = point({ x: e.clientX, y: e.clientY }); if (!at) return
    if (Math.hypot(at.x - g.x, at.y - g.y) < 2 && !g.moved) return
    g.moved = true
    const original = family ? g.doc.family.people.find((p) => p.id === g.id)! : g.doc[field.kind as 'house' | 'body'].items.find((p) => p.id === g.id)!
    const x = Math.max(0, Math.min(family ? 700 : 820 - (original as Item).width, original.x + at.x - g.x))
    const y = Math.max(0, Math.min(family ? 450 : 560 - (original as Item).height, original.y + at.y - g.y))
    setMoving(editObject({ x, y }, g.doc))
  }
  async function apply() {
    if (busy) return
    setBusy(true); setError('')
    try { await onApply(nextDiagram(field.kind, doc, field.value?.revision ?? 0), field.value); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : '反映できませんでした'); setConfirm(false) }
    finally { setBusy(false) }
  }
  const kinds: Item['kind'][] = field.kind === 'body' ? ['disability', 'loss', 'pressure', 'pain', 'paralysis', 'contracture', 'note'] : ['room', 'wall', 'bed', 'rail', 'step', 'wheelchair', 'furniture', 'note']
  return createPortal(<dialog ref={root} className={`diagram-editor${large ? ' diagram-large' : ''}`} aria-labelledby="diagram-title" onCancel={(e) => { e.preventDefault(); close() }}>
    <header><div><small>図の確認・手直し</small><h2 id="diagram-title">{field.title}</h2></div><button onClick={() => setLarge(!large)}>{large ? '文字を標準に' : '文字を大きく'}</button><button disabled={busy} onClick={close}>保存せず戻る</button></header>
    <fieldset disabled={busy || confirm} className="diagram-workspace">
      <section className="diagram-drawing" aria-label="図の編集領域">
        <div className="diagram-toolbar"><button disabled={index === 0} onClick={() => { setIndex(index - 1); select('') }}>元に戻す</button><button disabled={index === history.length - 1} onClick={() => { setIndex(index + 1); select('') }}>やり直す</button><button onClick={() => setZoom(Math.max(.5, zoom - .25))} aria-label="図を縮小">−</button><button onClick={() => setZoom(1)}>全体表示</button><button onClick={() => setZoom(Math.min(2, zoom + .25))} aria-label="図を拡大">＋</button></div>
        <div className="diagram-scroll"><div ref={canvas} className="diagram-canvas" style={{ width: `${zoom * 100}%` }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={(e) => { if (moving) commit(moving); drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }} onPointerCancel={() => { drag.current = null; setMoving(null) }}>
          <Preview doc={doc} tab={field.kind} selected={selected} editing />
        </div></div>
        <p>{pendingBody ? '図の上で配置する位置を選んでください。' : '図を押して選ぶと、内容を編集できます。位置調整ボタンでも動かせます。'}</p>
      </section>
      <aside aria-label="入力と調整">
        <button aria-expanded={palette} onClick={() => setPalette(!palette)}>足りない図形を追加する</button>
        {palette && <div className="diagram-palette">{family ? (['female', 'male', 'unknown'] as const).map((sex) => <button key={sex} {...paletteDrag.bind({ sex }, () => add({ sex }))}><ObjectThumbnail sex={sex} />{sex === 'female' ? '女性' : sex === 'male' ? '男性' : '不明'}</button>) : kinds.map((kind) => <button key={kind} {...(field.kind === 'body' ? { onClick: () => setPendingBody(kind) } : paletteDrag.bind({ kind }, () => add({ kind })))} aria-pressed={pendingBody === kind}><ObjectThumbnail kind={kind} />{labels[kind]}</button>)}</div>}
        <label>一覧から選ぶ<select value={selected} onChange={(e) => select(e.target.value)}><option value="">選択してください</option>{objects.map((o, i) => <option key={o.id} value={o.id}>{('name' in o ? o.name : o.label) || `名称未入力 ${i + 1}`}</option>)}</select></label>
        {object && <div className="diagram-properties">
          <label>{family ? '名前' : '名称'}<input value={person?.name ?? item?.label ?? ''} maxLength={300} onChange={(e) => commit(editObject(family ? { name: e.target.value } : { label: e.target.value }))} /></label>
          {person && <>
            <label>年齢<input type="number" min={0} max={130} value={person.age ?? ''} onChange={(e) => commit(editObject({ age: e.target.value === '' ? null : Number(e.target.value) }))} /></label>
            <label>性別<select value={person.sex} onChange={(e) => commit(editObject({ sex: e.target.value as Person['sex'] }))}><option value="female">女性</option><option value="male">男性</option><option value="unknown">不明</option></select></label>
            <label>同居・別居<select value={person.household} onChange={(e) => commit(editObject({ household: e.target.value as Person['household'] }))}>{['同居', '別居', '不明'].map((s) => <option key={s}>{s}</option>)}</select></label>
            <label><input type="checkbox" checked={!!person.isSubject} onChange={(e) => commit({ ...doc, family: { ...doc.family, people: doc.family.people.map((p) => ({ ...p, isSubject: e.target.checked ? p.id === selected : p.id === selected ? false : p.isSubject })) } })} />本人</label>
            <label><input type="checkbox" checked={!!person.deceased} onChange={(e) => commit(editObject({ deceased: e.target.checked }))} />死亡</label>
          </>}
          {item && <>
            {(['width', 'height', 'rotation'] as const).map((key) => <label key={key}>{({ width: '幅', height: '高さ', rotation: '回転' })[key]}<input type="number" min={key === 'rotation' ? -360 : 20} max={key === 'width' ? 820 : key === 'height' ? 560 : 360} value={item[key]} onChange={(e) => commit(editObject({ [key]: Number(e.target.value) }))} /></label>)}
            {item.kind === 'step' && <label>段差の高さ（cm）<input type="number" min={0} max={1000} value={item.stepHeightCm ?? ''} onChange={(e) => commit(editObject({ stepHeightCm: e.target.value === '' ? null : Number(e.target.value) }))} /></label>}
            {field.kind === 'body' && <label>正面・背面<select value={item.view} onChange={(e) => { const back = e.target.value === 'back'; commit(editObject({ view: back ? 'back' : 'front', x: back ? Math.min(740, item.x < 410 ? item.x + 410 : item.x) : item.x >= 410 ? item.x - 410 : item.x })) }}><option value="front">正面</option><option value="back">背面</option></select></label>}
          </>}
          <div className="diagram-arrows" role="group" aria-label="位置調整">{([['←', -10, 0], ['↑', 0, -10], ['↓', 0, 10], ['→', 10, 0]] as const).map(([label, x, y]) => <button key={label} onClick={() => commit(editObject({ x: Math.max(0, Math.min(family ? 700 : 820 - item!.width, object.x + x)), y: Math.max(0, Math.min(family ? 450 : 560 - item!.height, object.y + y)) }))}>{label}</button>)}</div>
          <button onClick={() => { if (family) commit(removePerson(doc, selected)); else { const kind = field.kind as 'house' | 'body'; commit({ ...doc, [kind]: { ...doc[kind], items: doc[kind].items.filter((p) => p.id !== selected) } }) } select('') }}>選択した図形を削除</button>
        </div>}
        {family && <details><summary>家族の線</summary>{(['source', 'target'] as const).map((key) => <label key={key}>{key === 'source' ? '接続元（親）' : '接続先（子）'}<select value={relation[key]} onChange={(e) => setRelation({ ...relation, [key]: e.target.value })}><option value="">選択してください</option>{doc.family.people.map((p, i) => <option key={p.id} value={p.id}>{p.name || `名称未入力 ${i + 1}`}</option>)}</select></label>)}<label>関係<select value={relation.kind} onChange={(e) => setRelation({ ...relation, kind: e.target.value as Relation['kind'] })}>{['婚姻', '離婚', '親子'].map((s) => <option key={s}>{s}</option>)}</select></label><button disabled={!relation.source || !relation.target} onClick={() => commit({ ...doc, family: { ...doc.family, relations: [...doc.family.relations, { id: uid(), ...relation }] } })}>線を追加</button>{doc.family.relations.map((r) => <div key={r.id}>{doc.family.people.find((p) => p.id === r.source)?.name || '名称未入力'} → {doc.family.people.find((p) => p.id === r.target)?.name || '名称未入力'}（{r.kind}）<button onClick={() => commit({ ...doc, family: { ...doc.family, relations: doc.family.relations.filter((p) => p.id !== r.id) } })}>線を削除</button></div>)}</details>}
      </aside>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <footer>{confirm ? <><p>この図の変更を用紙に反映します。書類の「保存」で保存版に確定します。</p><button disabled={busy} onClick={() => setConfirm(false)}>編集に戻る</button><button disabled={busy} onClick={() => void apply()}>{busy ? '反映中…' : '用紙に反映'}</button></> : <><span>{changed ? '図を変更しました。' : '変更はありません。'}</span><button disabled={!changed} onClick={() => setConfirm(true)}>確認へ進む</button></>}</footer>
    {paletteDrag.preview}
  </dialog>, document.body)
}
