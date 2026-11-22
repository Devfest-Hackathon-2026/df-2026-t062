import { CareRecordDraftPanel } from './CareRecordDraftPanel.tsx'
import { useEffect, useRef, useState } from 'react'
import type { CareRecordSummary, CareRecordRevision } from '../../../core/care-record.ts'
import { sameValue } from '../../../core/apply-batch.ts'
import { api } from '../../lib/api.ts'
import { downloadBlob } from '../../lib/download.ts'
import { useDocument } from '../document/useDocument.ts'
import { FieldConflicts } from '../document/FieldConflicts.tsx'
import './CareRecordWork.css'

export function CareRecordWork({ clientId, clientName, onBack }: { clientId: string, clientName: string, onBack: () => void }) {
  const [id, setId] = useState<string>()
  const [records, setRecords] = useState<CareRecordSummary[]>([])
  const [filters, setFilters] = useState({ q: '', from: '', to: '', offset: 0 })
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const createRequest = useRef<string | undefined>(undefined)
  const [revisions, setRevisions] = useState<{ rev: number, savedAt: string }[]>([])
  const [past, setPast] = useState<CareRecordRevision>()
  const historyRequest = useRef(0)
  const state = useDocument(id)
  const ready = !!id && state.doc?.id === id
  const dirty = ready && (state.hasLocalEdits || !sameValue(state.current, state.saved))
  const values = past?.values ?? state.current
  const text = (key: string) => typeof values[key] === 'string' ? values[key] as string : ''
  const editable = ready && !past && !busy
  useEffect(() => {
    let active = true
    setLoading(true)
    const timer = setTimeout(() => {
      api.careRecords(clientId, filters).then(r => { if (active) { setRecords(r.records); setMore(r.hasMore) } }, e => { if (active) setError(e instanceof Error ? e.message : '一覧を取得できませんでした') }).finally(() => { if (active) setLoading(false) })
    }, 180)
    return () => { active = false; clearTimeout(timer) }
  }, [clientId, filters, reload])
  useEffect(() => { setPast(undefined); setRevisions([]); historyRequest.current++ }, [id])
  useEffect(() => {
    if (!id) return
    let active = true
    api.revisions(id).then(r => { if (active) setRevisions(r.revisions) }, e => { if (active) setError(e instanceof Error ? e.message : '履歴を取得できませんでした') })
    return () => { active = false }
  }, [id, reload])
  useEffect(() => {
    if (!dirty) return
    const leave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [dirty])
  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : '処理できませんでした。入力は保持しています。') }
    finally { busyRef.current = false; setBusy(false) }
  }
  const preserve = async () => {
    if (!dirty) return true
    if (!window.confirm('入力を保存して移動しますか？ キャンセルするとこの記録に留まります。')) return false
    if (!await state.saveDocument()) return false
    setReload(n => n + 1)
    return true
  }
  const select = (next: string) => { if (id !== next) void run(async () => { if (await preserve()) { historyRequest.current++; setPast(undefined); setId(next) } }) }
  const create = () => void run(async () => {
    if (!await preserve()) return
    createRequest.current ??= crypto.randomUUID()
    const result = await api.createCareRecord(clientId, 'care_plan_5', createRequest.current)
    createRequest.current = undefined; setPast(undefined); setId(result.id); setReload(n => n + 1)
  })
  const showRevision = (rev: string) => void run(async () => {
    if (!id || !await preserve()) return
    const request = ++historyRequest.current
    if (!rev) { setPast(undefined); return }
    const r = await api.careRecordRevision(id, Number(rev))
    if (request === historyRequest.current) setPast(r.revision)
  })
  const save = () => void run(async () => { if (await state.saveDocument()) setReload(n => n + 1) })
  const exportPdf = () => void run(async () => {
    if (!id || (!past && dirty)) return
    downloadBlob(await api.pdf(id, past?.rev), '居宅介護支援経過_' + clientName + '.pdf')
  })
  return <main className="care-record-work">
    <header className="care-record-header"><button className="btn" type="button" disabled={busy} onClick={() => void run(async () => { if (await preserve()) onBack() })}>書類に戻る</button><h1>{clientName} さんの支援経過</h1><button type="button" className="savebtn" disabled={busy} onClick={create}>＋ 支援経過を追加</button></header>
    <div className="care-record-columns">
      <aside className="care-record-list" aria-label="支援経過の記録一覧">
        <label>記録を検索<input type="search" value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value, offset: 0 }))} /></label>
        <div className="care-record-dates"><label>開始日<input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value, offset: 0 }))} /></label><label>終了日<input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value, offset: 0 }))} /></label></div>
        {loading ? <p role="status">記録を読み込んでいます…</p> : !records.length ? <p>該当する支援経過はありません。</p> : <ol>{records.map(r => <li key={r.id}><button type="button" disabled={busy} aria-pressed={r.id === id} onClick={() => select(r.id)}><strong>{r.date ?? '日時未入力'} {r.time ?? ''}</strong><span>{r.category || '項目未入力'}</span><small>{r.preview || '内容未入力'}</small><small>記録 {r.seq} ・ {r.revision ? '保存版 ' + r.revision : '未保存'}</small></button></li>)}</ol>}
        <nav aria-label="記録一覧のページ"><button className="btn" disabled={!filters.offset || loading} onClick={() => setFilters(f => ({ ...f, offset: Math.max(0, f.offset - 50) }))}>前の50件</button><button className="btn" disabled={!more || loading} onClick={() => setFilters(f => ({ ...f, offset: f.offset + 50 }))}>次の50件</button></nav>
      </aside>
      <section className="care-record-editor" aria-label="支援経過の編集">
        {(error || state.error) && <p role="alert" className="care-record-error">{error || state.error}</p>}
        {state.notice && <p role="status">{state.notice}</p>}
        {!id ? <p>記録を選ぶか、「支援経過を追加」で新しい記録を作成してください。</p> : !ready ? <p role="status">記録を読み込んでいます…</p> : <>
          <div className="care-record-toolbar"><span role="status">{past ? '保存版 ' + past.rev + 'を表示中（閲覧のみ）' : dirty ? '保存していない変更があります' : state.doc?.rev ? '保存済み（最終確定とは異なります）' : '未保存'}</span><button className="savebtn" disabled={!editable} onClick={save}>記録を保存</button><button className="btn" disabled={busy || (!past && (dirty || !state.doc?.rev)) || !state.hasPdf} onClick={exportPdf}>{past ? 'この保存版のPDF' : '第5表PDF'}</button></div>
          <label>修正履歴<select aria-label="修正履歴" value={past?.rev ?? ''} disabled={busy} onChange={e => showRevision(e.target.value)}><option value="">現在の記録</option>{revisions.map(r => <option key={r.rev} value={r.rev}>保存版 {r.rev} ・ {new Date(r.savedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</option>)}</select></label>
          <FieldConflicts state={state} />
          <fieldset disabled={!editable}>
            <legend>支援経過</legend>
            <div className="care-record-dates"><label>記録年月日<input type="date" value={text('progress.date')} onChange={e => state.setValue('progress.date', e.target.value || null)} /></label><label>記録時刻<input type="time" value={text('progress.time')} onChange={e => state.setValue('progress.time', e.target.value || null)} /></label><label>作成年月日<input type="date" value={text('plan.createdDate')} onChange={e => state.setValue('plan.createdDate', e.target.value || null)} /></label></div>
            <label>項目・連絡方法<input value={text('progress.category')} onChange={e => state.setValue('progress.category', e.target.value || null)} maxLength={300} placeholder="例：訪問（自宅）、電話（受信）" /></label>
            <label>記録内容<textarea aria-label="記録内容" value={text('progress.content')} onChange={e => state.setValue('progress.content', e.target.value || null)} rows={17} maxLength={100000} /></label>
            <label>記載者<input value={text('office.careManagerName')} onChange={e => state.setValue('office.careManagerName', e.target.value || null)} /></label>
          </fieldset>
          {!past && id && <CareRecordDraftPanel key={id} documentId={id} beforeAdopt={state.flush} onApplied={async () => { await state.reload(); setReload(n => n + 1) }} />}
        </>}
      </section>
    </div>
  </main>
}
