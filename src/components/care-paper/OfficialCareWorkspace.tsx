import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CarePaperFlow } from './CarePaperFlow.ts'
import { toFormDef, type FormAssetsView, type FormDef } from '../../../core/form.ts'
import { editablePages } from './editablePages.ts'
import { expandPrintLayout } from '../../../core/print-layout.ts'
import type { Binding } from '../../../core/binding.ts'
import { api } from '../../lib/api.ts'
import { PaperText, type PaperTextField } from './PaperText.tsx'
import './care-paper.css'

/** PDF出力と同じ原紙・印字座標を使用する。保存版はその版の値と様式を読む。 */
export function OfficialCareWorkspace({ documentId, formKind, revision, formVersionId, savedRevision, values, title, status, children, disabled=false, readOnly = false, staticFields = false, textField, toolbar, operationsLabel = '入力・修正', operationsAvailable = !!documentId, onStart, details }: {
  documentId?: string, formKind?:string, revision?: number, formVersionId?: string, savedRevision?: number, values: Record<string, unknown>, title: string, status?: ReactNode, children: ReactNode, disabled?:boolean,
  readOnly?: boolean,
  staticFields?: boolean,
  textField?: (slot: string, binding: Binding | undefined, page: number, rowOffset: number) => PaperTextField | undefined,
  toolbar?: ReactNode, operationsLabel?: string, operationsAvailable?: boolean, onStart?: () => void,
  details?: { slot: string, content: ReactNode },
}) {
  const [loaded, setLoaded] = useState<{ identity: string, form: FormDef, assets: FormAssetsView, base: Record<string, unknown> }>()
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(100)
  const [pageIndex, setPageIndex] = useState(0)
  const continuous=useContext(CarePaperFlow)
  const [editing,setEditing]=useState(false)
  const focusSlot=useRef<string|undefined>(undefined)
  const operations = useRef<HTMLElement>(null)
  useEffect(()=>setEditing(false),[documentId])
  const identity = `${documentId ?? formKind}:${revision ?? 'current'}:${formVersionId ?? ''}`
  useEffect(() => {
    let alive = true
    setError('')
    void (async () => {
      const source = documentId ? revision
        ? (await api.careRecordRevision(documentId, revision)).revision
        : (await api.document(documentId)).document : undefined
      if(!source&&!formKind&&!formVersionId)throw new Error('表示する様式が指定されていません')
      const versionId = formVersionId ?? source?.formVersionId ?? (await api.publishedForm(formKind!)).formVersionId
      const [version, assets] = await Promise.all([api.formVersion(versionId), api.formAssets(versionId)])
      const base = !source ? {} : 'values' in source ? source.values : Object.fromEntries(Object.entries(source.fields).map(([key, field]) => [key, field.value]))
      if (alive) setLoaded({ identity, form: toFormDef(version), assets, base })
    })().catch(e => { if (alive) setError(e instanceof Error ? e.message : '用紙を読み込めませんでした') })
    return () => { alive = false }
  }, [documentId, formKind, revision, formVersionId, savedRevision, identity])
  const current = loaded?.identity === identity ? loaded : undefined
  const rendered = useMemo(() => {
    if (!current) return { pages: [], baseline: [] }
    try {
      return { pages: editablePages(current.form, { ...current.base, ...values }), baseline: expandPrintLayout(current.form, current.base, { checkOverflow: false }) }
    } catch { return { pages: [], baseline: [] } }
  }, [current, values])
  const visibleIndex = Math.min(pageIndex, Math.max(0, rendered.pages.length - 1))
  const openEditor = (slot?: string) => {
    if (!documentId && onStart) { onStart(); return }
    focusSlot.current=slot
    setEditing(true)
  }
  useEffect(()=>{
    if(!editing)return
    const editor = operations.current
    if (!editor) return
    editor.scrollIntoView({ block: 'nearest' })
    const slot=focusSlot.current
    if (!slot) return
    const label = slot.split('__')[0].split('_')[0]
    const field = [...editor.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')].find(e => !e.disabled && ((e.getAttribute('aria-label') ?? '').includes(label) || (e.closest('label')?.textContent ?? '').includes(label)))
    field?.focus()
    field?.scrollIntoView({ block: 'nearest' })
  },[editing])
  return <div className="care-paper-workspace">
    <div className="care-paper-toolbar"><strong>{title}</strong>{status && <span role="status" className="care-paper-status">{status}</span>}<div role="group" aria-label="用紙の拡大"><button type="button" className="btn" aria-label="用紙を縮小" onClick={() => setZoom(z => Math.max(80, z - 20))}>−</button><span>{zoom}%</span><button type="button" className="btn" aria-label="用紙を拡大" onClick={() => setZoom(z => Math.min(180, z + 20))}>＋</button></div>{!continuous && rendered.pages.length > 1 && <div role="group" aria-label="用紙のページ"><button type="button" className="btn" aria-label="前の用紙" disabled={visibleIndex === 0} onClick={() => setPageIndex(visibleIndex - 1)}>‹</button><span>{visibleIndex + 1} / {rendered.pages.length}</span><button type="button" className="btn" aria-label="次の用紙" disabled={visibleIndex === rendered.pages.length - 1} onClick={() => setPageIndex(visibleIndex + 1)}>›</button></div>}{toolbar}<button className="btn" type="button" disabled={disabled||!current||!operationsAvailable} onClick={() => openEditor()}>{operationsLabel}</button></div>
    <div className="care-paper-scroll" aria-label="公式様式の用紙">
      {editing && operationsAvailable && <section ref={operations} className="care-paper-operations" aria-label={`${title}の操作`}>
        <header><strong>{title}の操作</strong><button className="btn" type="button" onClick={() => setEditing(false)}>用紙に戻る</button></header>
        {children}
      </section>}
      {error ? <p role="alert">{error}</p> : !current ? <p role="status">用紙を読み込んでいます…</p> : !rendered.pages.length ? <p role="alert">用紙を表示できません。入力内容は保持しています。</p> : rendered.pages.flatMap((printed, index) => {
        if (!continuous && index !== visibleIndex) return []
        const page = current.form.pages.find(p => p.pdfIndex === printed.sourceIndex)!
        const image = current.assets.pages.find(p => p.no === page.no)?.url
        return <div className="care-paper-size" key={`${printed.sourceIndex}:${index}`} style={{ width: `${zoom}%` }}>
          <div className="care-paper-page" style={{ aspectRatio: `${page.width}/${page.height}` }}>
            {image ? <img className="care-paper-image" src={image} alt={`${title} 原紙 ${index + 1}`} onError={() => setError('原紙画像を読み込めませんでした。再表示してください。')} /> : <p role="alert">この様式の原紙画像がありません。</p>}
            {image && printed.schemas.filter(s => s.type !== 'image').map(s => {
              const slot = s.name.replace(/__row\d+|__slot\d+|__empty/g, '')
              const circle = s.type === 'circleMark'
              const selected = circle && printed.input[s.name] === 'true'
              const klass = `care-paper-field${selected ? ' care-paper-mark-selected' : ''}${(printed.input[s.name] ?? '') !== (rendered.baseline[index]?.input[s.name] ?? '') ? ' care-paper-changed' : ''}`
              const style = { left: `${s.position.x / page.width * 100}%`, top: `${s.position.y / page.height * 100}%`, width: `${s.width / page.width * 100}%`, height: `${s.height / page.height * 100}%`, fontSize: `${(s.fontSize ?? 8) * .3528 / page.width * 100}cqw`, lineHeight: s.lineHeight ?? 1.15, textAlign: s.alignment ?? 'left', color: s.color ? `#${s.color.replace('#', '')}` : '#1452a3' } as const
              const rowOffset = page.print?.type === 'sections' ? index * (page.print.list?.rowsPerPage ?? 0) : 0
              const field = !s.name.endsWith('__empty') && textField?.(slot, current.form.bindings[slot], index, rowOffset)
              if (field) return <PaperText key={s.name} field={field} className={klass} style={style} disabled={disabled || readOnly} />
              if (details?.slot === slot && rendered.pages.findIndex(p => p.sourceIndex === printed.sourceIndex) === index) {
                return <div key={s.name} className="paper-details" style={style}>
                  {details.content}
                  <details><summary>印字内容</summary><pre>{printed.input[s.name]}</pre></details>
                </div>
              }
              if (staticFields) return <span key={s.name} className="care-paper-printed" style={style}>{printed.input[s.name] ?? ''}</span>
              return <button data-field-key={current.form.bindings[slot]?.ref.key} type="button" disabled={disabled||(!documentId&&!onStart)} key={s.name} className={klass} aria-label={`${slot}（入力・修正）`} onClick={() => openEditor(slot)} style={style}>{circle ? '' : printed.input[s.name] ?? ''}</button>
            })}
          </div>
        </div>
      })}
    </div>
  </div>
}
