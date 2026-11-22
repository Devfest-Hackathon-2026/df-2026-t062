import { drawingPoint, contains, moveHouseItem, resizeItem, resizeLine, rotateHouseItem, STEP_MARKER_SIZE, lineGeometry, type LineEndpoint, type ResizeCorner } from '../../../core/diagram/interaction.ts'
import { roomsBehind } from '../../../core/diagram/svg.ts'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { diagramDocument, nextDiagram, type DiagramField, type DiagramValue } from '../../../core/diagram/fields.ts'
import { housePaletteKinds, labels, removePerson, uid, schema, type Doc, type Item, type Person, type Relation } from '../../../core/diagram/model.ts'
import Preview from './Preview.tsx'
import ObjectThumbnail from './ObjectThumbnail.tsx'
import usePaletteDrag, { type PaletteObject } from './usePaletteDrag.tsx'
import './editor.css'

const defaultSizes: Partial<Record<Item['kind'], readonly [number, number]>> = {
  room: [200, 160],
  step: [STEP_MARKER_SIZE, STEP_MARKER_SIZE],
  door: [64, 64],
  toilet: [44, 68],
  bathtub: [104, 62],
}

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
  const [line, setLine] = useState<{ kind: 'wall' | 'rail', start?: { x: number, y: number }, preview?: { x: number, y: number } } | null>(null)
  const [pendingPlacement, setPendingPlacement] = useState<Item['kind'] | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [large, setLarge] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [relation, setRelation] = useState({ source: '', target: '', kind: '婚姻' as Relation['kind'] })
  const root = useRef<HTMLDialogElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const stepTap = useRef<{ pointerId: number, x: number, y: number } | null>(null)
  const drag = useRef<{
    pointerId: number
    original: Item | Person
    at: { x: number, y: number }
    doc: Doc
    corner?: ResizeCorner
    endpoint?: LineEndpoint
    moved: boolean
  } | null>(null)
  const [moving, setMoving] = useState<Doc | null>(null)
  const doc = moving ?? history[index]
  const house = field.kind === 'house'
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
  function editObject(patch: Partial<Item & Person>, source = doc, id = selected) {
    if (family) return { ...source, family: { ...source.family, people: source.family.people.map((p) => p.id === id ? { ...p, ...patch } : p) } }
    const kind = field.kind as 'house' | 'body'
    return { ...source, [kind]: { ...source[kind], items: source[kind].items.map((p) => p.id === id ? { ...p, ...patch } : p) } }
  }
  function point(client: { x: number, y: number }, allowOutside = false) {
    const svg = canvas.current?.querySelector('svg')
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return null
    return drawingPoint(client, matrix, allowOutside)
  }
  function add(object: PaletteObject, at = { x: 300, y: 220 }) {
    setLine(null)
    const id = uid()
    if ('sex' in object) {
      const person: Person = { id, sex: object.sex, name: '', household: '不明', deceased: false, x: Math.min(700, at.x), y: Math.min(450, at.y) }
      commit({ ...doc, family: { ...doc.family, people: [...doc.family.people, person] } })
    } else {
      const body = field.kind === 'body'
      const [width, height] = defaultSizes[object.kind] ?? [80, 60]
      const x = object.kind === 'step' ? at.x - width / 2 : at.x
      const y = object.kind === 'step' ? at.y - height / 2 : at.y
      const item: Item = { id, kind: object.kind, label: labels[object.kind], x: Math.max(0, Math.min(house ? 820 - width : 780, x)), y: Math.max(0, Math.min(house ? 560 - height : 520, y)), width, height, rotation: 0, ...(body ? { view: at.x < 410 ? 'front' as const : 'back' as const } : {}) }
      const kind = field.kind as 'house' | 'body'
      commit({ ...doc, [kind]: { ...doc[kind], items: [...doc[kind].items, item] } })
    }
    select(id); setPendingPlacement(null)
  }
  const paletteDrag = usePaletteDrag((object, client) => { const at = point(client); if (at) add(object, at) }, house)
  function close() { if (!busy && (!changed || window.confirm('この図の変更を破棄して戻りますか？'))) onClose() }
  function pointerDown(e: PointerEvent<HTMLDivElement>) {
    if (busy || confirm || !e.isPrimary || e.button !== 0) return
    const corner = house && e.target instanceof Element
      ? e.target.closest('[data-resize-corner]')?.getAttribute('data-resize-corner') as ResizeCorner | undefined
      : undefined
    const endpoint = house && e.target instanceof Element
      ? e.target.closest('[data-line-endpoint]')?.getAttribute('data-line-endpoint') as LineEndpoint | undefined
      : undefined
    const at = point({ x: e.clientX, y: e.clientY }, !!corner || !!endpoint)
    if (!at) return
    if (line) {
      if (!line.start) {
        setLine({ kind: line.kind, start: at })
      } else {
        const { geometry } = lineGeometry(line.start, at)
        if (geometry.width < 2) return
        const id = uid()
        const item: Item = {
          id, kind: line.kind, label: labels[line.kind], ...geometry,
          ...(line.kind === 'wall' ? { wallLine: true } : { railLine: true }),
        }
        commit({ ...doc, house: { ...doc.house, items: [...doc.house.items, item] } })
        select(id)
        setLine(null)
      }
      return
    }
    if (pendingPlacement === 'step') {
      stepTap.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    if (pendingPlacement) { add({ kind: pendingPlacement }, at); return }
    // Rooms are always behind other objects, including hit testing.
    const ordered = family ? objects : roomsBehind(objects as Item[])
    const hit = corner || endpoint ? item : [...ordered].reverse().find((o) => contains(o, at))
    select(hit?.id ?? '')
    if (!hit) return
    drag.current = { pointerId: e.pointerId, original: hit, at, doc: history[index], corner, endpoint, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function updateDrag(e: PointerEvent<HTMLDivElement>) {
    const gesture = drag.current
    if (!gesture || gesture.pointerId !== e.pointerId || busy || confirm) return
    const at = point({ x: e.clientX, y: e.clientY }, house)
    if (!at) return
    const delta = { x: at.x - gesture.at.x, y: at.y - gesture.at.y }
    if (!gesture.moved && Math.hypot(delta.x, delta.y) < 2) return
    gesture.moved = true
    const { original, corner, endpoint } = gesture
    if (endpoint && 'width' in original) {
      const resized = resizeLine(original, endpoint, delta)
      return resized ? editObject(resized, gesture.doc, original.id) : undefined
    }
    const patch = house && 'width' in original
      ? corner ? resizeItem(original, corner, delta) : moveHouseItem(original, delta)
      : {
      x: Math.max(0, Math.min('width' in original ? 820 - original.width : 700, original.x + delta.x)),
      y: Math.max(0, Math.min('height' in original ? 560 - original.height : 450, original.y + delta.y)),
    }
    return editObject(patch, gesture.doc, original.id)
  }
  function pointerMove(e: PointerEvent<HTMLDivElement>) {
    if (line?.start && e.isPrimary) {
      const preview = point({ x: e.clientX, y: e.clientY })
      if (preview) setLine({ ...line, preview: lineGeometry(line.start, preview).end })
      return
    }
    const next = updateDrag(e)
    if (next) setMoving(next)
  }
  function clearDrag(e: PointerEvent<HTMLDivElement>) {
    if (stepTap.current?.pointerId === e.pointerId) stepTap.current = null
    if (drag.current?.pointerId !== e.pointerId) return
    drag.current = null
    setMoving(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  function pointerUp(e: PointerEvent<HTMLDivElement>) {
    const tap = stepTap.current
    if (tap?.pointerId === e.pointerId) {
      stepTap.current = null
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
      if (pendingPlacement === 'step' && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) <= 8) {
        const at = point({ x: e.clientX, y: e.clientY })
        if (at) add({ kind: 'step' }, at)
      }
      return
    }
    if (drag.current?.pointerId !== e.pointerId) return
    const next = updateDrag(e) ?? moving
    clearDrag(e)
    if (next) commit(next)
  }
  async function apply() {
    if (busy) return
    setBusy(true); setError('')
    try { await onApply(nextDiagram(field.kind, doc, field.value?.revision ?? 0), field.value); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : '反映できませんでした'); setConfirm(false) }
    finally { setBusy(false) }
  }
  const kinds: readonly Item['kind'][] = field.kind === 'body' ? ['disability', 'loss', 'pressure', 'pain', 'paralysis', 'contracture', 'note'] : housePaletteKinds
  return createPortal(<dialog ref={root} className={`diagram-editor${house ? ' diagram-house' : large ? ' diagram-large' : ''}`} aria-labelledby="diagram-title" onCancel={(e) => { e.preventDefault(); if (line) setLine(null); else if (house && pendingPlacement) setPendingPlacement(null); else close() }}>
    <header><div><small>図の確認・手直し</small><h2 id="diagram-title">{field.title}</h2></div>{!house && <button onClick={() => setLarge(!large)}>{large ? '文字を標準に' : '文字を大きく'}</button>}<button disabled={busy} onClick={close}>保存せず戻る</button></header>
    <fieldset disabled={busy || confirm} className="diagram-workspace">
      <section className="diagram-drawing" aria-label="図の編集領域">
        <div className="diagram-toolbar"><button disabled={index === 0} onClick={() => { setIndex(index - 1); select(''); setLine(null) }}>元に戻す</button><button disabled={index === history.length - 1} onClick={() => { setIndex(index + 1); select(''); setLine(null) }}>やり直す</button>{!house && <><button onClick={() => setZoom(Math.max(.5, zoom - .25))} aria-label="図を縮小">−</button><button onClick={() => setZoom(1)}>全体表示</button><button onClick={() => setZoom(Math.min(2, zoom + .25))} aria-label="図を拡大">＋</button></>}</div>
        <div className="diagram-scroll"><div ref={canvas} className={line || (house && pendingPlacement) ? 'diagram-canvas diagram-place-tool' : 'diagram-canvas'} style={house ? undefined : { width: `${zoom * 100}%` }}
          onPointerDown={pointerDown} onPointerMove={pointerMove}
          onPointerUp={pointerUp} onPointerCancel={clearDrag} onLostPointerCapture={clearDrag}>
          <Preview doc={doc} tab={field.kind} selected={selected} editing />
          {line?.start && <svg className="diagram-line-preview" viewBox="0 0 820 560" aria-hidden="true">
            {line.preview && <line x1={line.start.x} y1={line.start.y} x2={line.preview.x} y2={line.preview.y} stroke={line.kind === 'rail' ? '#387772' : '#684ac7'} strokeWidth="5" strokeDasharray="10 6" />}
            <circle cx={line.start.x} cy={line.start.y} r="7" fill="#684ac7" />
          </svg>}
        </div></div>
        {line ? <p role="status">{labels[line.kind]}の{line.start ? '終点を指定してください。向きは45度刻みです。' : '始点を指定してください。'}</p>
          : pendingPlacement === 'step' ? <p role="status">段差を置く場所をタップしてください。</p>
          : <p>{pendingPlacement ? '図の上で配置する位置を選んでください。' : item?.wallLine || item?.railLine ? '線の両端に出る丸をドラッグすると、長さや向きを変えられます。' : house ? '図形をドラッグして移動し、選んだ図形の四隅をドラッグしてサイズを変えます。' : '図を押して選ぶと、内容を編集できます。位置調整ボタンでも動かせます。'}</p>}
      </section>
      <aside aria-label="入力と調整">
        {!house && <button aria-expanded={palette} onClick={() => setPalette(!palette)}>足りない図形を追加する</button>}
        {(house || palette) && <div className="diagram-palette" role="group" aria-label={house ? '追加する図形・家具' : '追加する図形'}>
          {family ? (['female', 'male', 'unknown'] as const).map((sex) =>
            <button key={sex} {...paletteDrag.bind({ sex }, () => add({ sex }))}>
              <ObjectThumbnail sex={sex} />{sex === 'female' ? '女性' : sex === 'male' ? '男性' : '不明'}
            </button>
          ) : kinds.map((kind) => {
            if (house && (kind === 'wall' || kind === 'rail')) return <button key={kind} aria-pressed={line?.kind === kind}
              onClick={() => { setLine(line?.kind === kind ? null : { kind }); setPendingPlacement(null); select(''); setError('') }}>
              <ObjectThumbnail kind={kind} house />{labels[kind]}
            </button>
            if (house && kind === 'step') return <button key={kind} aria-pressed={pendingPlacement === kind}
              onClick={() => { setPendingPlacement(pendingPlacement === kind ? null : kind); setLine(null); select(''); setError('') }}>
              <ObjectThumbnail kind={kind} house />段差
            </button>
            const body = field.kind === 'body'
            return <button key={kind} {...(body ? { onClick: () => setPendingPlacement(kind) } : paletteDrag.bind({ kind }, () => add({ kind })))} aria-pressed={body ? pendingPlacement === kind : undefined}>
              <ObjectThumbnail kind={kind} house={house} />{labels[kind]}
            </button>
          })}
        </div>}
        {!house && <label>一覧から選ぶ<select value={selected} onChange={(e) => select(e.target.value)}><option value="">選択してください</option>{objects.map((o, i) => <option key={o.id} value={o.id}>{('name' in o ? o.name : o.label) || `名称未入力 ${i + 1}`}</option>)}</select></label>}
        {object && <div className="diagram-properties">
          {!house && <label>{family ? '名前' : '名称'}<input value={person?.name ?? item?.label ?? ''} maxLength={300} onChange={(e) => commit(editObject(family ? { name: e.target.value } : { label: e.target.value }))} /></label>}
          {person && <>
            <label>年齢<input type="number" min={0} max={130} value={person.age ?? ''} onChange={(e) => commit(editObject({ age: e.target.value === '' ? null : Number(e.target.value) }))} /></label>
            <label>性別<select value={person.sex} onChange={(e) => commit(editObject({ sex: e.target.value as Person['sex'] }))}><option value="female">女性</option><option value="male">男性</option><option value="unknown">不明</option></select></label>
            <label>同居・別居<select value={person.household} onChange={(e) => commit(editObject({ household: e.target.value as Person['household'] }))}>{['同居', '別居', '不明'].map((s) => <option key={s}>{s}</option>)}</select></label>
            <label><input type="checkbox" checked={!!person.isSubject} onChange={(e) => commit({ ...doc, family: { ...doc.family, people: doc.family.people.map((p) => ({ ...p, isSubject: e.target.checked ? p.id === selected : p.id === selected ? false : p.isSubject })) } })} />本人</label>
            <label><input type="checkbox" checked={!!person.deceased} onChange={(e) => commit(editObject({ deceased: e.target.checked }))} />死亡</label>
          </>}
          {item && <>
            {house ? item.kind !== 'step' && <button onClick={() => {
              const rotated = rotateHouseItem(item)
              if (rotated) commit(editObject(rotated))
              else setError('図の範囲に収まらないため回転できません。')
            }}>右に90°回転</button> : (['width', 'height', 'rotation'] as const).map((key) => <label key={key}>{({ width: '幅', height: '高さ', rotation: '回転' })[key]}<input type="number" min={key === 'rotation' ? -360 : 20} max={key === 'width' ? 820 : key === 'height' ? 560 : 360} value={item[key]} onChange={(e) => commit(editObject({ [key]: Number(e.target.value) }))} /></label>)}
            {field.kind === 'body' && <label>正面・背面<select value={item.view} onChange={(e) => { const back = e.target.value === 'back'; commit(editObject({ view: back ? 'back' : 'front', x: back ? Math.min(740, item.x < 410 ? item.x + 410 : item.x) : item.x >= 410 ? item.x - 410 : item.x })) }}><option value="front">正面</option><option value="back">背面</option></select></label>}
          </>}
          {!house && <div className="diagram-arrows" role="group" aria-label="位置調整">{([['←', -10, 0], ['↑', 0, -10], ['↓', 0, 10], ['→', 10, 0]] as const).map(([label, x, y]) => <button key={label} onClick={() => commit(editObject({ x: Math.max(0, Math.min(family ? 700 : 820 - item!.width, object.x + x)), y: Math.max(0, Math.min(family ? 450 : 560 - item!.height, object.y + y)) }))}>{label}</button>)}</div>}
          <button onClick={() => { if (family) commit(removePerson(doc, selected)); else { const kind = field.kind as 'house' | 'body'; commit({ ...doc, [kind]: { ...doc[kind], items: doc[kind].items.filter((p) => p.id !== selected) } }) } select('') }}>選択した図形を削除</button>
        </div>}
        {family && <details><summary>家族の線</summary>{(['source', 'target'] as const).map((key) => <label key={key}>{key === 'source' ? '接続元（親）' : '接続先（子）'}<select value={relation[key]} onChange={(e) => setRelation({ ...relation, [key]: e.target.value })}><option value="">選択してください</option>{doc.family.people.map((p, i) => <option key={p.id} value={p.id}>{p.name || `名称未入力 ${i + 1}`}</option>)}</select></label>)}<label>関係<select value={relation.kind} onChange={(e) => setRelation({ ...relation, kind: e.target.value as Relation['kind'] })}>{['婚姻', '離婚', '親子'].map((s) => <option key={s}>{s}</option>)}</select></label><button disabled={!relation.source || !relation.target} onClick={() => commit({ ...doc, family: { ...doc.family, relations: [...doc.family.relations, { id: uid(), ...relation }] } })}>線を追加</button>{doc.family.relations.map((r) => <div key={r.id}>{doc.family.people.find((p) => p.id === r.source)?.name || '名称未入力'} → {doc.family.people.find((p) => p.id === r.target)?.name || '名称未入力'}（{r.kind}）<button onClick={() => commit({ ...doc, family: { ...doc.family, relations: doc.family.relations.filter((p) => p.id !== r.id) } })}>線を削除</button></div>)}</details>}
      </aside>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <footer>{confirm ? <><p>この図の変更を用紙に反映します。書類の「保存」で保存版に確定します。</p><button disabled={busy} onClick={() => setConfirm(false)}>編集に戻る</button><button disabled={busy} onClick={() => void apply()}>{busy ? '反映中…' : '用紙に反映'}</button></> : <><span>{changed ? '図を変更しました。' : '変更はありません。'}</span><button disabled={!changed} onClick={() => { setConfirm(true); setLine(null); setPendingPlacement(null) }}>確認へ進む</button></>}</footer>
    {paletteDrag.preview}
  </dialog>, document.body)
}
