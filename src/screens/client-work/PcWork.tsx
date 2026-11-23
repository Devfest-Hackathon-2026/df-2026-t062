import { CarePlanArea, isCarePlanRelatedKind } from '../../components/care-plan/CarePlanArea.tsx'
// PC ② 作業画面（キャンバス Main）。新しい利用者は ③（PcNew）、2 回目からの書き換えのあとは ④（PcDiff）の印になる。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fieldDict } from '../../../core/dictionary.ts'
import { countRequired } from '../../../core/required.ts'
import { FieldConflicts } from '../../components/document/FieldConflicts.tsx'
import { H, W } from '../../components/document/layout.ts'
import type { SurveyPreview } from '../../components/survey/readSurvey.ts'
import { availableTopics, reviewItems } from '../../components/assistant/topics.ts'
import { fieldTargets } from '../../components/document/fields.ts'
import { mergeSurveyDrafts, stageSurvey, surveyOverlays, type SurveyDraft } from '../../components/survey/stage.ts'
import { FormPage } from '../../components/document/FormPage.tsx'
import { DocumentOutput } from '../../components/document/DocumentOutput.tsx'
import { SheetToolbar } from '../../components/document/SheetToolbar.tsx'
import { useClient } from '../../components/document/useClient.ts'
import { pickDocument, useFormKinds } from '../../components/document/useFormKinds.ts'
import { useDocument } from '../../components/document/useDocument.ts'
import { api } from '../../lib/api.ts'
import { linkProps } from '../../lib/router.tsx'
import { COMING_SOON_LABEL, newDocMenu } from './docMenu.ts'
import { PetHelper } from '../../components/assistant/PetHelper.tsx'
import { countText } from '../../components/document/changes.ts'
import { downloadBlob } from '../../lib/download.ts'
import { PlanHistoryButton, isPlanKind } from '../../components/care-plan/CarePlanWork.tsx'
import { FillDialog, fillStepIndex, fillStepLabel } from '../../components/document/FillDialog.tsx'
import { useDocumentFill } from '../../components/document/useDocumentFill.ts'
import type { PetFill } from '../../components/assistant/PetHelper.tsx'

export function PcWork({ clientId, staffName }: { clientId: string, staffName: string }) {
  // 開いている書類の種類（空なら主な書類）
  const [tab, setTab] = useState('')
  const [carePlanOpen, setCarePlanOpen] = useState(false)
  const [planHistoryRequest, setPlanHistoryRequest] = useState(0)
  const [planOutputTarget, setPlanOutputTarget] = useState<HTMLDivElement | null>(null)
  const [planDirty, setPlanDirty] = useState(false)
  const [planBusy, setPlanBusy] = useState(false)
  const diagramRequestId = useRef(0)
  const [diagramChatRequest, setDiagramChatRequest] = useState<{ key: string, id: number }>()
  const reloadDoc = useRef<() => void>(() => {})
  const { client, jobs, reload: reloadClient } = useClient(clientId, () => reloadDoc.current())
  const kinds = useFormKinds()
  const open = pickDocument(kinds, client?.documents, tab)
  const docId = open.docId
  const state = useDocument(docId)
  reloadDoc.current = () => { void state.reload(); void reloadClient() }
  const [zoom, setZoom] = useState(100)
  const [cur, setCur] = useState(0)
  const [newOpen, setNewOpen] = useState(false)
  const [docSaved, setDocSaved] = useState(false)
  const [savedPages, setSavedPages] = useState<Set<number>>(new Set())
  const scroller = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<(HTMLDivElement | null)[]>([])
  const [staged, setStaged] = useState<{ docId: string, drafts: SurveyDraft[] }>()
  const [verifiedSources, setVerifiedSources] = useState<Set<string>>(new Set())
  const [highlight, setHighlight] = useState('')
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [adoptingKey, setAdoptingKey] = useState('')
  const adoption = useRef<Promise<boolean> | null>(null)
  const [candidateError, setCandidateError] = useState('')
  // 書類を作るときに AI が書く（#195）: 作った直後に聞く書類と、書いている間のダイアログ
  const [fillAsk, setFillAsk] = useState('')
  const [fillShown, setFillShown] = useState(false)

  useEffect(() => { setDiagramChatRequest(undefined); setDocSaved(false); setSavedPages(new Set()); setCur(0) }, [docId])
  useEffect(() => { if (state.pendingCount || state.total.ai || state.total.hand) setDocSaved(false) }, [state.pendingCount, state.total.ai, state.total.hand])

  /** 元の書類（create_from の種類）があり、AI が書ける種類か（ケアプランは対象外） */
  function canFillFrom(key: string) {
    const from = kinds?.find((k) => k.key === key)?.createFrom
    return !!from && !isPlanKind(key) && !!client?.documents.some((d) => d.kind === from)
  }
  // 種類のタブを開く。その種類の書類がまだなければ作る（db/repo.ts の createDocument。写す種類は写す）
  const openKind = useCallback(async (key: string) => {
    if (planBusy || (carePlanOpen && planDirty && !window.confirm('保存していない入力があります。入力を破棄して移動しますか？'))) return
    setCarePlanOpen(false); setPlanDirty(false)
    setNewOpen(false)
    if (!client?.documents.some((d) => d.kind === key)) {
      const r = await api.createDocument(clientId, key)
      if (r.created && canFillFrom(key)) setFillAsk(r.id)
      await reloadClient()
    }
    setTab(key)
  }, [client, kinds, clientId, reloadClient, carePlanOpen, planDirty, planBusy, state.flush])
  // 何通も作れる種類は、押すたびに新しい書類を作る
  const createKind = useCallback(async (key: string) => {
    if (planBusy || (carePlanOpen && planDirty && !window.confirm('保存していない入力があります。入力を破棄して移動しますか？'))) return
    setNewOpen(false)
    const r = await api.createDocument(clientId, key)
    if (r.created && canFillFrom(key)) setFillAsk(r.id)
    await reloadClient()
    setTab(key)
  }, [clientId, reloadClient, client, kinds, planBusy, carePlanOpen, planDirty])

  const doc = state.doc
  const isPrimary = open.isPrimary
  const fillable = !!docId && canFillFrom(open.key)
  const filling = useDocumentFill(fillable ? docId : undefined, () => reloadDoc.current())
  const fillSource = open.fromName ?? ''
  const runFill = () => { setFillAsk(''); setFillShown(true); void filling.start() }
  const petFill: PetFill | undefined = !fillable || !filling.loaded ? undefined
    : filling.working ? { phase: 'working', step: fillStepLabel(Math.min(2, fillStepIndex(filling.fill!.step)), fillSource), onShow: () => setFillShown(true) }
      : filling.justDone ? { phase: 'done', sourceName: fillSource, changes: filling.fill?.changes ?? 0 }
        : !filling.fill || filling.fill.status === 'failed' ? { phase: 'offer', sourceName: fillSource, onRun: runFill, error: filling.error || undefined }
          : undefined
  const kindName = open.kind?.name ?? ''
  const pages = state.pages
  /** ページが何枚もある書類（ページの番号・いまのページを出す） */
  const paged = isPrimary || pages.length > 1
  const assessmentReady = isPrimary && !!doc && doc.id === docId && state.form?.id === doc.formVersionId
  const targets = useMemo(() => fieldTargets(pages), [pages])
  const drafts = assessmentReady && staged?.docId === doc.id ? staged.drafts : []
  const overlays = surveyOverlays(drafts, state.current, state.saved, targets)
  const review = assessmentReady ? reviewItems(doc, state.current, state.saved, drafts, targets) : []
  const topics = assessmentReady ? availableTopics(state.current, targets, open.kind?.required ?? []) : []

  useEffect(() => () => clearTimeout(highlightTimer.current), [])

  const jumpToField = (key: string) => {
    if (carePlanOpen) {
      if (planBusy || (planDirty && !window.confirm('ケアプランの未保存の入力を破棄し、参照元の入力欄に移動しますか？'))) return false
      setCarePlanOpen(false); setPlanDirty(false)
      // 用紙が戻った次の描画で、保持していた参照元の入力欄へ移動する。
      requestAnimationFrame(() => jumpToFieldInAssessment(key))
      return targets.has(key)
    }
    return jumpToFieldInAssessment(key)
  }
  const jumpToFieldInAssessment = (key: string) => {
    const el = scroller.current
    const target = assessmentReady ? targets.get(key) : undefined
    const sheet = target && pageRefs.current[target.pageIndex]?.querySelector('.pg')
    if (!el || !target || !sheet || !sheet.clientHeight) return false
    const slot = target.slots.find((s) => overlays.has(s.name) || state.display(s.name) === 'true' || state.display(s.name) === '✓') ?? target.slots[0]
    const sheetBox = sheet.getBoundingClientRect()
    const viewport = el.getBoundingClientRect()
    const top = sheetBox.top - viewport.top + el.scrollTop + slot.y / H * sheet.clientHeight
    const left = sheetBox.left - viewport.left + slot.x / W * sheet.clientWidth
    const outside = left < 0 || left + slot.w / W * sheet.clientWidth > el.clientWidth
    el.scrollTo({
      top: top - Math.min(100, el.clientHeight / 4),
      left: outside ? el.scrollLeft + left - el.clientWidth / 4 : el.scrollLeft,
      behavior: 'instant',
    })
    setCur(target.pageIndex)
    clearTimeout(highlightTimer.current)
    setHighlight(slot.name)
    highlightTimer.current = setTimeout(() => setHighlight(''), 2500)
    return true
  }

  const stagePreview = (preview: SurveyPreview) => {
    if (!assessmentReady) throw new Error('アセスメントを開き直してから読み取ってください。')
    const incoming = stageSurvey(preview, state.current, state.saved)
    const next = mergeSurveyDrafts(drafts, incoming)
    setStaged({ docId: doc.id, drafts: next })
    setCandidateError('')
    return [...surveyOverlays(next, state.current, state.saved, targets).values()].filter((draft) => draft.source.sha256 === preview.sha256).length
  }

  const blockDraft = (key: string) => {
    setStaged((previous) => previous && previous.docId === docId && previous.drafts.some((draft) => draft.candidate.key === key)
      ? { ...previous, drafts: previous.drafts.map((draft) => draft.candidate.key === key ? { ...draft, blocked: true } : draft) }
      : previous)
  }

  const adoptCandidate = (slot: string) => {
    const draft = overlays.get(slot)
    if (!assessmentReady || !draft || draft.candidate.choice === null || adoption.current) return
    const { candidate: { key, choice }, source: { sha256, fileName, recordedOn } } = draft
    if (!verifiedSources.has(sha256)) {
      setCandidateError('「書類を取り込む」で原本の対象者を確認してから、黄色の選択肢を選んでください。')
      return
    }
    setCandidateError('')
    setAdoptingKey(key)
    const run = async () => {
      try {
        if (!await state.flush()) return false
        await state.adoptSurvey({ fileName, sha256, recordedOn, changes: [{ key, choice, base: null }] })
        blockDraft(key)
        setDocSaved(false)
        return true
      } catch {
        await state.reload()
        setCandidateError('候補を入力できませんでした。現在の値を確認してから、もう一度選んでください。')
        return false
      } finally {
        adoption.current = null
        setAdoptingKey('')
      }
    }
    adoption.current = run()
  }

  const canSave = () => adoption.current ?? Promise.resolve(true)

  const maxW = Math.round(820 * zoom / 100)
  const required = isPrimary && doc && open.kind ? countRequired(state.current, open.kind.required) : client?.required ?? { filled: 0, total: 84 }
  const latestBatch = doc?.batches[0]
  const batchLabel = latestBatch?.label ?? 'AI 書き込み'
  const empty = !!doc && !doc.batches.length && Object.keys(doc.fields).every((k) => k === 'person.name' || k === 'person.sex')
  const hasUpdates = state.updates.size > 0
  const copied = doc?.batches.find((b) => b.kind === 'copy')?.changes ?? 0
  const incomplete = isPrimary && (jobs[0]?.status === 'partial' || jobs[0]?.status === 'failed') ? jobs[0] : null

  const onScroll = () => {
    const el = scroller.current
    if (!el || !paged) return
    const y = el.scrollTop + el.clientHeight * 0.3
    let idx = 0
    pageRefs.current.forEach((p, i) => { if (p && p.offsetTop - el.offsetTop <= y) idx = i })
    if (idx !== cur) setCur(idx)
  }
  const jump = (i: number) => {
    const el = scroller.current, p = pageRefs.current[i]
    if (el && p) el.scrollTo({ top: p.offsetTop - el.offsetTop - 4, behavior: 'smooth' })
  }

  const exportPdf = async () => {
    if (!docId) return
    await state.flush()
    const blob = await api.pdf(docId)
    downloadBlob(blob, `${client?.name ?? ''}_${kindName}.pdf`)
  }

  const pageLabel = (no: number, title: string, i: number) => {
    const c = state.counts.get(no) ?? { ai: 0, hand: 0 }
    const dirty = !!(c.ai || c.hand)
    return (
      <div className="plabel" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span>{paged ? `${no} ・ ${title}` : title}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#5B6672' }}>{dirty ? countText(c) : savedPages.has(no) ? '保存しました' : i === 0 && empty ? 'まだ何も書かれていません' : ''}</span>
          <button type="button" className="pgsave" disabled={!dirty} onClick={async () => { if (!await canSave() || !await state.savePage(no)) return; setSavedPages((s) => new Set(s).add(no)) }} style={dirty ? undefined : { opacity: 0.35, cursor: 'default' }}>このページを保存</button>
        </span>
      </div>
    )
  }


  return (
    <div className="pc pc-work" style={{ fontFamily: "'Noto Sans JP',system-ui,sans-serif", color: '#1F2430', background: '#F4F5F7', fontSize: 14, lineHeight: 1.6, display: 'flex', flexDirection: 'column' }}>

      <div className="pc-work-client" style={{ flex: '0 0 auto', background: '#FFFFFF', borderBottom: '1px solid #E1E4EA', padding: '10px 28px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 24px' }}>
        <a {...linkProps('/')} onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          if (planBusy || (carePlanOpen && planDirty && !window.confirm('ケアプランの未保存の入力を破棄して利用者一覧に移動しますか？'))) { e.preventDefault(); return }
          linkProps('/').onClick(e)
        }} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, textDecoration: 'none' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>利用者一覧
        </a>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{client ? `${client.name} さん` : ' '}</h1>
        </div>
        <div role="tablist" aria-label="書類" className="pc-work-tabs">
          {(kinds ?? []).filter((k) => !isCarePlanRelatedKind(k.key) && (client?.documents.some((d) => d.kind === k.key) || (k.available && k.perClient === 'one'))).map((k) => (
            <button key={k.key} className={`dtab${!carePlanOpen && k.key === open.key ? ' dtab-on' : ''}`} role="tab" aria-selected={!carePlanOpen && k.key === open.key} disabled={planBusy} type="button" onClick={() => void openKind(k.key)}>{k.name}</button>
          ))}
          {kinds?.filter((k) => isPlanKind(k.key) && k.available).length === 3 && <button className={`dtab${carePlanOpen ? ' dtab-on' : ''}`} role="tab" aria-selected={carePlanOpen} type="button" disabled={planBusy || !state.doc} onClick={async () => { if (await state.flush()) { setNewOpen(false); setPlanHistoryRequest(0); setCarePlanOpen(true) } }}>ケアプラン</button>}
          {carePlanOpen && <PlanHistoryButton disabled={planBusy} onClick={() => setPlanHistoryRequest(n => n + 1)} />}
          <button className="dtab dtab-add" type="button" disabled={carePlanOpen} aria-haspopup="true" aria-expanded={newOpen} onClick={() => setNewOpen(!newOpen)}>＋ 書類を作る</button>
          {newOpen && (
            <div role="menu" style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 'min(300px, 100%)', background: '#FFFFFF', border: '1px solid #E1E4EA', borderRadius: 12, boxShadow: '0 10px 30px rgba(20,24,32,0.18)', padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ fontSize: 12, color: '#5A6270', padding: '4px 8px 6px' }}>{client?.name}さんの今の情報から、AI が書き込みます</div>
              {(kinds ?? []).filter((k) => !isCarePlanRelatedKind(k.key) && k.available && k.perClient === 'many').map((k) => (
                <button key={k.key} className="mi" role="menuitem" type="button" onClick={() => void createKind(k.key)}><span>{k.name}</span></button>
              ))}
              {newDocMenu.map((d) => (
                <button key={d.label} className="mi" role="menuitem" type="button" disabled={!d.available} aria-disabled={!d.available} onClick={() => setNewOpen(false)}><span>{d.label}</span>{!d.available && <span className="mi-s coming-soon">{COMING_SOON_LABEL}</span>}</button>
              ))}
            </div>
          )}
        </div>
        {carePlanOpen ? <div className="pc-work-output" ref={setPlanOutputTarget} /> : <DocumentOutput
          status={<>必須 {required.total} 欄のうち {required.filled} 欄が入っています</>}
          progress={required} disabled={!docId} onExport={() => void exportPdf()} />}
      </div>

      <div className="pc-work-layout">
        {carePlanOpen ? <CarePlanArea availableKinds={(kinds ?? []).filter(k => k.available || client?.documents.some(d => d.kind === k.key)).map(k => k.key)} embedded historyRequest={planHistoryRequest} outputTarget={planOutputTarget} clientId={clientId} clientName={client?.name ?? ''} touch={false}
          onDirtyChange={setPlanDirty} onBusyChange={setPlanBusy} onBack={() => { setCarePlanOpen(false); setPlanDirty(false) }} /> : <>
        <nav aria-label="ページ" style={{ minWidth: 0, minHeight: 0, overflow: 'auto', background: '#FFFFFF', border: '1px solid #E1E4EA', borderRadius: 12, padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 2, boxSizing: 'border-box' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#5A6270', padding: '0 8px 6px' }}>{isPrimary ? `${kindName}用紙` : kindName}</div>
          {pages.map((p, i) => {
            const n = state.updates.get(p.no) ?? 0
            return (
              <button key={p.no} type="button" className={`nav-i${i === cur ? ' nav-on' : ''}`} aria-current={i === cur} onClick={() => jump(i)}>
                <span className="no">{p.no}</span><span style={{ flex: '1 1 auto' }}>{p.title}</span>
                {n > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: '#17703F', background: '#DCF2E4', borderRadius: 999, padding: '0 7px' }}>{n}</span>}
              </button>
            )
          })}
        </nav>

        <section aria-label="書類" style={{ minWidth: 0, minHeight: 0, background: '#FFFFFF', border: '1px solid #E1E4EA', borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
          <SheetToolbar title={paged ? pages[cur]?.title ?? kindName : kindName}
            page={paged ? `${cur + 1} / ${pages.length || 11} ページ` : '1 / 1 ページ'}
            zoom={zoom} onZoom={setZoom} hasUpdates={hasUpdates}
            status={empty ? 'まだ何も書かれていません' : countText(state.total) || 'すべて保存済み'} saved={docSaved}
            onSave={() => void (async () => { const ok = await canSave() && await state.saveDocument(); setDocSaved(ok); if (ok) setSavedPages(new Set(pages.map((p) => p.no))) })()} />

          <FieldConflicts state={state} />
          <div ref={scroller} onScroll={onScroll} style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', background: '#E9EBEF', padding: '10px 21px 20px' }}>
            {incomplete && <div role="alert" style={{ margin: '0 auto 12px', maxWidth: maxW, padding: '10px 14px', background: '#FFF4E5', border: '1px solid #F0C78A', borderRadius: 8, fontSize: 13 }}>
              {incomplete.status === 'partial' ? 'AI が一部の項目を処理できませんでした。用紙の内容を確認してください。' : 'AI 処理を完了できませんでした。録音は保存されています。担当者に確認してください。'}
            </div>}
            {state.error && <div role="alert" style={{ margin: `0 auto 12px`, maxWidth: maxW, color: '#A3261C', fontSize: 13 }}>うまく送れませんでした（{state.error}）。少し待ってから、もう一度直してください。</div>}
            {open.fromName && doc && (
              <div style={{ margin: '0 auto 14px', maxWidth: maxW }}>
                <div role="status" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: '#FFF4E5', border: '1px solid #F0C78A', borderRadius: 10, padding: '10px 14px', fontSize: 13, lineHeight: 1.5 }}>
                  <span aria-hidden="true" style={{ flex: '0 0 auto', width: 22, height: 22, borderRadius: 6, background: '#1F2430', color: '#FFFFFF', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700 }}>AI</span>
                  <div><strong>{open.fromName}から {copied} 欄を写しました（橙）。</strong>写したあとは、どちらかで直しても、もう片方は変わりません。</div>
                </div>
              </div>
            )}
            {doc && pages.map((p, i) => (
              <div key={`${doc.id}-${p.no}`} ref={(el) => { pageRefs.current[i] = el }} style={{ margin: '0 auto 24px', width: `${zoom}%`, maxWidth: maxW }}>
                {pageLabel(p.no, p.title, i)}
                <FormPage page={p} state={state} touch={false} disabled={false} batchLabel={batchLabel}
                  onDiagramChat={(key) => setDiagramChatRequest({ key, id: ++diagramRequestId.current })}
                  petFocus={assessmentReady ? highlight : undefined} provisional={assessmentReady ? overlays : undefined}
                  adoptingKey={assessmentReady ? adoptingKey : undefined} onAdopt={adoptCandidate} onEditChoice={assessmentReady ? blockDraft : undefined} />
              </div>
            ))}
          </div>
          {assessmentReady && candidateError && <div className="pc-pet-candidate-error" role="alert">{candidateError}</div>}
          {state.notice && (
            <div role="status" style={{ position: 'absolute', left: '50%', bottom: 20, transform: 'translateX(-50%)', zIndex: 7, display: 'inline-flex', alignItems: 'center', gap: 8, background: '#1F2430', color: '#FFFFFF', borderRadius: 999, padding: '10px 18px', fontSize: 13, boxShadow: '0 8px 24px rgba(20,24,32,0.25)', maxWidth: '90%' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>{state.notice}
            </div>
          )}
        </section>
        </>}

        <PetHelper key="work-assistant" clientId={clientId} beforeDocumentAdopt={state.flush} onDocumentApplied={() => { void state.reload() }} diagramRequest={diagramChatRequest} available={assessmentReady} clientName={client?.name ?? ''} review={review} topics={topics} unheard={doc?.id === docId ? state.unheard : []}
          onJump={jumpToField} onPreview={stagePreview} verifiedSources={verifiedSources}
          chat={{ documentId: doc?.id === docId ? doc?.id : undefined, current: state.current, saved: state.saved, onSet: state.setValue, onDiagramApply: state.applyDiagram, dict: fieldDict(state.form?.localFields) }}

          fill={carePlanOpen ? undefined : petFill}
          onIdentity={(sha, confirmed) => {
            setCandidateError('')
            setVerifiedSources((previous) => {
              const next = new Set(previous)
              if (confirmed) next.add(sha)
              else next.delete(sha)
              return next
            })
          }} />
      </div>
      {!carePlanOpen && fillable && fillAsk === docId && filling.loaded && !filling.fill && (
        <FillDialog phase="ask" sourceName={fillSource} kindName={kindName} onRun={runFill} onDecline={() => setFillAsk('')} />
      )}
      {!carePlanOpen && fillShown && filling.working && (
        <FillDialog phase="working" sourceName={fillSource} step={filling.fill!.step} onHide={() => setFillShown(false)} />
      )}
    </div>
  )
}
