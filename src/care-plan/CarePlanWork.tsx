import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CarePlanView, CarePlanSummary, NeedInput, SlotInput, AiDraftDetail } from '../../db/care-plans.ts'
import { api, ApiError } from '../lib/api.ts'
import { downloadBlob } from '../components/Chrome.tsx'
import { FormPage } from '../form/FormPage.tsx'
import { FieldConflicts } from '../form/FieldConflicts.tsx'
import { useDocument } from '../form/useDocument.ts'
import { DocumentHeader, DailyActivities } from './DocumentFields.tsx'
import { savePlanEdits, documentDirty } from './save.ts'
import './care-plan.css'

const isPlanKind = (key: string) => ['care_plan_1', 'care_plan_2', 'care_plan_3'].includes(key)
export { isPlanKind }
const names = ['第1表・基本情報と方針', '第2表・ニーズとサービス', '第3表・週間計画']
const days = ['月', '火', '水', '木', '金', '土', '日']
const statusText = (status: string) => status === 'draft' ? '下書き' : status === 'confirmed' ? '確定済み' : '旧版'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const message = (error: unknown) => {
  if (error instanceof ApiError) {
    if (error.code === 'conflict') return '別の画面で更新されています。入力を控えてから「読み直す」を押してください。入力は自動で上書きしません。'
    if (error.code === 'unsaved_changes') return '保存していない変更があります。第1〜3表を保存してから、もう一度お試しください。'
    if (error.code === 'not_draft') return 'この計画は確定済みです。読み直し、訂正は改定版を作って行ってください。'
    if (error.code === 'overflow') return `用紙の印字欄「${(error.details as { slots?: string[] }).slots?.join('、') ?? ''}」に収まりません。入力を確認して保存し直してください。確定済みの場合は改定版で訂正してください。`
    if (error.code === 'form_unavailable') return 'PDFの元の用紙がまだ用意されていません。管理者に確認してください。'
    if (error.code === 'validation_failed') {
      const detail = error.details as { problems?: { path: string, reason: string }[] }
      const labels: Record<string, string> = { overlap: '時間帯が重なっています', duplicate: '同じ予定が重複しています', invalid_time: '曜日・開始・終了・翌日終了を確認してください', invalid_other: '週単位以外の予定には内容を入力してください', period_order: '期間の開始・終了を確認してください', unknown_service: 'サービスを選び直してください' }
      return `入力を確認してください。${detail.problems?.map((p) => labels[p.reason] ?? 'ニーズ・目標・サービスの必須欄を確認してください').filter((v, i, a) => a.indexOf(v) === i).join('。') ?? ''}`
    }
  }
  return error instanceof Error ? error.message : '操作を完了できませんでした。入力を残したまま再試行できます。'
}

function Modal({ title, onClose, children }: { title: string, onClose: () => void, children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close() }, [])
  return <dialog ref={ref} aria-label={title} className="cp-dialog" onCancel={(e) => { e.preventDefault(); onClose() }}>
    <header><h2>{title}</h2><button className="btn" onClick={onClose} type="button">閉じる</button></header>{children}
  </dialog>
}

function SaveButton({ busy, disabled, save }: { busy: boolean, disabled: boolean, save: () => void }) {
  return <div className="cp-save">
    <span>第1〜3表の変更をまとめて保存します</span>
    <button type="button" className="btn btn-p" disabled={disabled || busy} onClick={save}>{busy ? '処理中…' : '保存'}</button>
  </div>
}

export function CarePlanWork({ clientId, clientName, touch, onBack }: { clientId: string, clientName: string, touch: boolean, onBack: () => void }) {
  const [plans, setPlans] = useState<CarePlanSummary[]>([])
  const [selected, setSelected] = useState<CarePlanView | null>(null)
  const [busy, setBusy] = useState(false)
  const [childBusy, setChildBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [copyFrom, setCopyFrom] = useState<string>()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const request = useRef(0)
  const loadList = () => api.carePlans(clientId).then((r) => { setPlans(r.plans); return r.plans })
  useEffect(() => {
    let alive = true
    api.carePlans(clientId).then(async (r) => {
      if (!alive) return
      setPlans(r.plans)
      if (r.plans[0]) {
        const result = await api.carePlan(r.plans[0].id)
        if (alive) setSelected(result.plan)
      } else setCreating(true)
    }).catch((e) => { if (alive) setError(message(e)) })
    return () => { alive = false }
  }, [clientId])
  const mayLeave = () => !dirty || window.confirm('保存していない入力があります。入力を破棄して移動しますか？')
  const choose = async (id: string) => {
    if (!mayLeave()) return
    const token = ++request.current
    setBusy(true); setError('')
    try { const r = await api.carePlan(id); if (request.current === token) { setSelected(r.plan); setDirty(false) } }
    catch (e) { setError(message(e)) } finally { if (request.current === token) setBusy(false) }
  }
  return <div className={`pc cp-work ${touch ? 'cp-touch' : ''}`}>
    <header className="cp-header">
      <button type="button" className="btn" disabled={busy || childBusy} onClick={() => { if (mayLeave()) onBack() }}>← 書類に戻る</button>
      <h1>{clientName} さん <small>ケアプラン</small></h1>
      <label>計画の版<select aria-label="計画の版" value={selected?.id ?? ''} disabled={busy || childBusy} onChange={(e) => void choose(e.target.value)}>
        <option value="" disabled>計画を選ぶ</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.effectiveFrom}〜・第{p.version}版・{statusText(p.status)}</option>)}
      </select></label>
      <button type="button" className="btn" disabled={busy || childBusy} onClick={() => { setCopyFrom(undefined); setCreating(true) }}>＋ 計画を作る</button>
    </header>
    {error && <div role="alert" className="cp-error">{error}</div>}
    {creating && <Modal title={copyFrom ? '改定版を作る' : '新しいケアプラン'} onClose={() => setCreating(false)}>
      <form onSubmit={async (e) => {
        e.preventDefault()
        if (!mayLeave()) return
        setBusy(true); setError('')
        try {
          const r = await api.createCarePlan(clientId, { effectiveFrom: from, effectiveTo: to || null, copyFromPlanId: copyFrom })
          setSelected(r.plan); setDirty(false); setCreating(false); await loadList()
        } catch (e) { setError(message(e)) } finally { setBusy(false) }
      }}>
        <p>第1〜3表を一緒に作ります。AIを使わず、手入力で作成できます。</p>
        <label>適用開始日<input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>適用終了日（任意）<input type="date" min={from || undefined} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {error && <p role="alert" className="cp-error">{error}</p>}
        <button className="btn btn-p" disabled={busy} type="submit">{busy ? '作成中…' : '第1〜3表を作る'}</button>
      </form>
    </Modal>}
    {selected ? <PlanEditor key={selected.id} initial={selected} clientName={clientName} touch={touch} onDirty={setDirty} onBusy={setChildBusy}
      onUpdated={() => { void loadList().catch((e) => setError(message(e))) }}
      onCopy={(plan) => { setCopyFrom(plan.id); setFrom(plan.effectiveFrom); setTo(plan.effectiveTo ?? ''); setCreating(true) }} />
      : !creating && <p className="cp-loading" role="status">計画を読み込んでいます…</p>}
  </div>
}

function PlanEditor({ initial, clientName, touch, onDirty, onBusy, onUpdated, onCopy }: {
  initial: CarePlanView, clientName: string, touch: boolean, onDirty: (dirty: boolean) => void,
  onBusy: (busy: boolean) => void, onUpdated: () => void, onCopy: (plan: CarePlanView) => void,
}) {
  const [plan, setPlan] = useState(initial)
  const [needs, setNeeds] = useState<NeedInput[]>(initial.needs)
  const [slots, setSlots] = useState<SlotInput[]>(initial.slots)
  const [active, setActive] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [needIndex, setNeedIndex] = useState<number | null>(null)
  const [slotIndex, setSlotIndex] = useState<number | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiDraft, setAiDraft] = useState<AiDraftDetail>()
  const [aiNeeds, setAiNeeds] = useState<Set<string>>(new Set())
  const gate = useRef(false)
  const first = useDocument(plan.documents.find((d) => d.formNo === 1)?.documentId)
  const second = useDocument(plan.documents.find((d) => d.formNo === 2)?.documentId)
  const third = useDocument(plan.documents.find((d) => d.formNo === 3)?.documentId)
  const documents = [first, second, third]
  const ready = documents.every((d) => !!d.doc && !!d.form)
  const structuralDirty = !same(needs, plan.needs) || !same(slots, plan.slots)
  const firstDirty = documents.some(documentDirty)
  const dirty = structuralDirty || firstDirty || plan.hasUnsavedChanges
  const readOnly = plan.status !== 'draft'
  useEffect(() => { onDirty(dirty); if (dirty) setNotice('') }, [dirty, onDirty])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const run = async (operation: () => Promise<void>) => {
    if (gate.current) return
    gate.current = true; setBusy(true); onBusy(true); setError(''); setNotice('')
    try { await operation() } catch (e) { setError(message(e)) }
    finally { gate.current = false; setBusy(false); onBusy(false) }
  }
  const refresh = async () => {
    const result = await api.carePlan(plan.id)
    setPlan(result.plan); setNeeds(result.plan.needs); setSlots(result.plan.slots)
    setAiNeeds(new Set())
    await Promise.all(documents.map((d) => d.reload()))
    onUpdated()
  }
  const save = () => void run(async () => {
    if (documents.some((d) => d.reasons.size)) throw new Error('入力欄に表示された理由を確認してください。')
    const result = await savePlanEdits({
      flush: async () => {
        for (const document of documents) if (!await document.flush()) return false
        return true
      },
      needs: async () => {
        if (same(needs, plan.needs)) return plan.lockVersion
        const r = await api.carePlanNeeds(plan.id, plan.lockVersion, needs)
        setPlan(r.plan); setNeeds(r.plan.needs)
        return r.plan.lockVersion
      },
      schedule: async (version) => {
        if (same(slots, plan.slots)) return version
        const r = await api.carePlanSchedule(plan.id, version, slots)
        setPlan(r.plan); setSlots(r.plan.slots)
        return r.plan.lockVersion
      },
      save: (version) => api.saveCarePlan(plan.id, version),
    })
    setPlan(result.plan); setNeeds(result.plan.needs); setSlots(result.plan.slots)
    setAiNeeds(new Set())
    await Promise.all(documents.map((d) => d.reload())); onUpdated(); setNotice('第1〜3表を保存しました')
  })
  const updateNeed = (index: number, mutate: (need: NeedInput) => void) => {
    setNotice('')
    const next = structuredClone(needs)
    mutate(next[index])
    const previousIds = needs[index].shortGoals?.flatMap((g) => g.services?.map((s) => s.id).filter(Boolean) ?? []) ?? []
    const currentIds = new Set(next[index].shortGoals?.flatMap((g) => g.services?.map((s) => s.id) ?? []))
    const removedIds = new Set(previousIds.filter((id) => !currentIds.has(id)))
    if (removedIds.size) setSlots(slots.filter((s) => !removedIds.has(s.serviceId)))
    setNeeds(next)
  }
  const updateSlot = (index: number, change: Partial<SlotInput>) => {
    setNotice(''); setSlots((old) => old.map((s, i) => i === index ? { ...s, ...change } : s))
  }
  const services = plan.needs.flatMap((n) => n.shortGoals.flatMap((g) => g.services))
  const saveButton = <SaveButton save={save} busy={busy} disabled={readOnly || !ready} />
  return <>
    <div className="cp-planbar">
      <span className={`cp-status cp-${plan.status}`}>{statusText(plan.status)}</span>
      <strong>第{plan.version}版</strong><span>{plan.effectiveFrom} 〜 {plan.effectiveTo ?? '終了日未設定'}</span>
      <span role="status">{dirty ? '保存していない変更があります' : plan.documents.every((d) => d.latestRevision > 0) ? '保存済み' : 'まだ保存されていません'}</span>
      <button className="btn" disabled={busy} onClick={() => { if (!dirty || window.confirm('保存していない入力を破棄して読み直しますか？')) void run(refresh) }}>読み直す</button>
      <button className="btn" disabled={busy} onClick={() => onCopy(plan)}>この計画をもとに改定版を作る</button>
      <button className="btn" disabled={busy || !ready || readOnly || structuralDirty || firstDirty} onClick={() => setAiOpen(true)}>AI原案を作る</button>
      {plan.aiDraft && <button className="btn" disabled={busy || !ready || readOnly || structuralDirty || firstDirty} onClick={() => void run(async () => {
        const result = await api.carePlanAiDraft(plan.id, plan.aiDraft!.id)
        setAiDraft(result.draft); setAiOpen(true)
      })}>前回のAI原案を開く</button>}
      <button className="btn" disabled={busy || !ready || readOnly || dirty || !plan.documents.every((d) => d.latestRevision > 0)} onClick={() => setConfirming(true)}>計画を確定</button>
      <button className="btn" disabled={busy || !ready || dirty || !plan.documents.every((d) => d.latestRevision > 0)} onClick={() => void run(async () => {
        const blob = await api.carePlanPdf(plan.id, 'all'); downloadBlob(blob, `${clientName}_ケアプラン_第${plan.version}版.pdf`)
      })}>第1〜3表をPDF出力</button>
    </div>
    {readOnly && <div className="cp-info">この計画は{statusText(plan.status)}のため編集できません。訂正する場合は改定版を作ってください。
      {plan.confirmation && <span> 確定日時：{new Date(plan.confirmation.confirmedAt).toLocaleString('ja-JP')}</span>}
    </div>}
    {error && <div role="alert" className="cp-error">{error}</div>}
    {documents.map((d, i) => d.error && <div key={i} role="alert" className="cp-error">第{i + 1}表の入力を送信できませんでした。入力を確認してください。</div>)}
    {notice && <div role="status" className="cp-notice">{notice}</div>}
    {!ready && <div role="status" className="cp-info">第1〜3表の入力を読み込んでいます…</div>}
    {dirty && <div className="cp-info">保存すると、確定・PDF出力・AI原案を利用できます。保存と確定は別の操作です。</div>}
    {documents.map((d, i) => <FieldConflicts key={i} state={d} />)}
    <div className="cp-layout">
      <nav className="cp-nav" aria-label="ケアプランの表">{names.map((name, i) => <button type="button" key={name} className={`nav-i ${active === i ? 'nav-on' : ''}`} aria-current={active === i ? 'page' : undefined} onClick={() => setActive(i)}><span className="no">{i + 1}</span>{name}</button>)}
        <div className="cp-legend">青：入力できる欄<br />橙：AIの未保存の変更<br />黄：手入力の未保存の変更</div>
      </nav>
      <main className="cp-canvas">
        <div className="plabel"><strong>{names[active]}</strong></div>
        {saveButton}
        {active === 0 && <>
          <div className="cp-zoom" role="group" aria-label="用紙の拡大">
            <button type="button" className="btn" disabled={zoom <= 75} onClick={() => setZoom((n) => n - 25)}>縮小</button>
            <span>{zoom}%</span>
            <button type="button" className="btn" disabled={zoom >= 200} onClick={() => setZoom((n) => n + 25)}>拡大</button>
            <small>100%で幅に合わせます。拡大すると用紙は横にもスクロールできます。</small>
          </div>
          <div className="cp-first-scroll"><div className="cp-first" style={{ width: `${zoom}%` }}>
            {first.pages.map((page) => <FormPage key={page.no} page={page} state={first} touch={touch} disabled={busy || readOnly} batchLabel="ケアプランのAI原案" combinedSave />)}
          </div></div>
        </>}
        {active === 1 && <section className="cp-paper" aria-label="第2表">
          <header><h2>居宅サービス計画書（2）</h2><button className="btn" disabled={busy || readOnly} onClick={() => {
            setNeeds([...needs, { need: '', longGoal: { goal: '' }, shortGoals: [] }]); setNeedIndex(needs.length)
          }}>＋ ニーズを追加</button></header>
          <DocumentHeader state={second} disabled={busy || readOnly} />
          <p>行を押すと、ニーズ・目標・サービスをまとめて編集できます。</p>
          <div className="cp-table-scroll"><table className="cp-table"><thead><tr><th>ニーズ</th><th>長期目標・期間</th><th>短期目標・期間</th><th>サービス・事業所・頻度</th><th>操作</th></tr></thead>
            <tbody>{needs.map((n, i) => <tr key={n.id ?? `new-${i}`} onClick={() => { if (!busy) setNeedIndex(i) }} className={!same(n, plan.needs[i]) ? 'cp-hand' : n.id && aiNeeds.has(n.id) ? 'cp-ai' : ''}>
              <td>{n.need || '未入力'}</td><td>{n.longGoal.goal || '未入力'}<small>{n.longGoal.periodText}</small></td>
              <td>{n.shortGoals?.map((g, j) => <p key={g.id ?? j}>{g.goal || '未入力'}<small>{g.periodText}</small></p>)}</td>
              <td>{n.shortGoals?.flatMap((g) => g.services ?? []).map((s, j) => <p key={s.id ?? j}>{s.content}<small>{s.provider} {s.frequency}</small></p>)}</td>
              <td><button type="button" className="btn" disabled={busy} onClick={() => setNeedIndex(i)}>{readOnly ? '詳細' : '編集'}</button>
                {!readOnly && <div className="cp-order">{[-1, 1].map((direction) => <button key={direction} type="button" className="btn" aria-label={`ニーズ${i + 1}を${direction < 0 ? '上' : '下'}へ`} disabled={busy || i + direction < 0 || i + direction >= needs.length} onClick={(e) => {
                  e.stopPropagation()
                  const next = [...needs]; [next[i], next[i + direction]] = [next[i + direction], next[i]]; setNeeds(next)
                }}>{direction < 0 ? '↑' : '↓'}</button>)}</div>}
              </td>
            </tr>)}</tbody></table></div>
          {!needs.length && <p>まだニーズがありません。「ニーズを追加」から手入力できます。</p>}
        </section>}
        {active === 2 && <section className="cp-paper" aria-label="第3表">
          <header><h2>週間サービス計画表</h2><button className="btn" disabled={busy || readOnly || !services.length} onClick={() => {
            setSlots([...slots, { serviceId: '', scheduleType: 'weekly', weekday: 1, start: '', end: '', endsNextDay: false }]); setSlotIndex(slots.length)
          }}>＋ 予定を追加</button></header>
          <DocumentHeader state={third} disabled={busy || readOnly} />
          <p>第2表でサービスを追加したら、一度保存してから予定を作れます。時間枠を押して編集します。</p>
          <div className="cp-week-scroll"><div className="cp-week">
            <div className="cp-hours">{Array.from({ length: 13 }, (_, i) => <span key={i} style={{ top: `${i / 12 * 100}%` }}>{i * 2}:00</span>)}</div>
            {days.map((day, dayIndex) => <div className="cp-day" key={day}><strong>{day}</strong><div className="cp-day-body">
              {slots.flatMap((s, index) => {
                if (s.scheduleType !== 'weekly' || !s.start || !s.end) return []
                const [h, m] = s.start.split(':').map(Number)
                const [eh, em] = s.end.split(':').map(Number)
                const start = h * 60 + m, end = eh * 60 + em
                const nextDay = s.endsNextDay
                const own = s.weekday === dayIndex + 1
                const carry = nextDay && end > 0 && (s.weekday! % 7) === dayIndex
                if (!own && !carry) return []
                const begin = carry ? 0 : start, finish = carry ? end : nextDay ? 1440 : end
                return <button key={`${s.id ?? index}-${carry ? 'carry' : 'own'}`} type="button" className={`cp-slot ${!same(s, plan.slots[index]) ? 'cp-hand' : ''}`} disabled={busy} style={{ top: `${begin / 1440 * 100}%`, minHeight: 42, height: `${Math.max(0, finish - begin) / 1440 * 100}%` }} onClick={() => setSlotIndex(index)}>
                  {carry ? '前日から ' : ''}{s.start}–{nextDay ? '翌' : ''}{s.end}<br />{services.find((v) => v.id === s.serviceId)?.content ?? 'サービス未選択'}
                </button>
              })}
            </div></div>)}
          </div></div>
          <h3>予定の一覧</h3>
          {slots.map((s, i) => s.scheduleType === 'weekly' && <button type="button" className="btn cp-other" key={s.id ?? i} disabled={busy} onClick={() => setSlotIndex(i)}>
            {days[(s.weekday ?? 1) - 1]} {s.start || '開始未入力'}–{s.endsNextDay ? '翌' : ''}{s.end || '終了未入力'} {services.find((v) => v.id === s.serviceId)?.content ?? 'サービス未選択'}
          </button>)}
          <h3>週単位以外のサービス</h3>
          {slots.map((s, i) => s.scheduleType === 'other' && <button className="btn cp-other" key={s.id ?? i} disabled={busy} onClick={() => setSlotIndex(i)}>{services.find((v) => v.id === s.serviceId)?.content}：{s.note || '未入力'}</button>)}
          <button className="btn" disabled={busy || readOnly || !services.length} onClick={() => { setSlots([...slots, { serviceId: '', scheduleType: 'other', note: '' }]); setSlotIndex(slots.length) }}>＋ 週単位以外を追加</button>
          <DailyActivities state={third} disabled={busy || readOnly} />
        </section>}
        {saveButton}
      </main>
    </div>
    {needIndex !== null && needs[needIndex] && <Modal title={`第2表・ニーズ ${needIndex + 1}`} onClose={() => setNeedIndex(null)}>
      <p>入力はこの画面に保持します。各表の「保存」で第1〜3表をまとめて保存してください。</p>
      <fieldset disabled={readOnly || busy}>
        <NeedFields need={needs[needIndex]} update={(change) => updateNeed(needIndex, change)} />
        <button className="btn cp-danger" onClick={() => { if (window.confirm('ニーズと、その下の目標・サービス・週間予定を削除しますか？')) {
          const ids = new Set(needs[needIndex].shortGoals?.flatMap((g) => g.services?.map((s) => s.id) ?? []))
          setSlots(slots.filter((s) => !ids.has(s.serviceId))); setNeeds(needs.filter((_, i) => i !== needIndex)); setNeedIndex(null)
        } }}>このニーズを削除</button>
      </fieldset>
    </Modal>}
    {slotIndex !== null && slots[slotIndex] && <Modal title="第3表・予定の編集" onClose={() => setSlotIndex(null)}>
      <fieldset disabled={readOnly || busy}>
        <label>第2表のサービス<select value={slots[slotIndex].serviceId} onChange={(e) => updateSlot(slotIndex, { serviceId: e.target.value })}>
          <option value="">サービスを選ぶ</option>{services.map((s) => <option key={s.id} value={s.id}>{s.content}（{s.provider ?? '事業所未入力'}）</option>)}
        </select></label>
        {slots[slotIndex].scheduleType === 'weekly' ? <>
          <label>曜日<select value={slots[slotIndex].weekday ?? 1} onChange={(e) => updateSlot(slotIndex, { weekday: Number(e.target.value) })}>{days.map((day, i) => <option value={i + 1} key={day}>{day}曜日</option>)}</select></label>
          <div className="cp-fields"><label>開始<input type="time" value={slots[slotIndex].start ?? ''} onChange={(e) => updateSlot(slotIndex, { start: e.target.value })} /></label>
            <label>終了<input type="time" value={slots[slotIndex].end ?? ''} onChange={(e) => updateSlot(slotIndex, { end: e.target.value })} /></label></div>
          <label className="cp-check"><input type="checkbox" checked={slots[slotIndex].endsNextDay ?? false} onChange={(e) => updateSlot(slotIndex, { endsNextDay: e.target.checked })} />終了は翌日</label>
        </> : <label>週単位以外の内容<textarea value={slots[slotIndex].note ?? ''} onChange={(e) => updateSlot(slotIndex, { note: e.target.value })} /></label>}
        <PeriodFields value={slots[slotIndex]} update={(change) => updateSlot(slotIndex, change)} text={false} />
        <button className="btn cp-danger" onClick={() => { setSlots(slots.filter((_, i) => i !== slotIndex)); setSlotIndex(null) }}>この予定を削除</button>
      </fieldset>
      <p>各表の「保存」で、第1〜3表をまとめて保存します。</p>
    </Modal>}
    {confirming && <Modal title="計画を確定しますか？" onClose={() => setConfirming(false)}>
      <p>第1〜3表の保存済みの内容を確定します。確定後は編集できません。訂正は改定版を作って行います。</p>
      <p>{plan.effectiveFrom} 〜 {plan.effectiveTo ?? '終了日未設定'}・第{plan.version}版</p>
      <button className="btn btn-p" disabled={busy || dirty} onClick={() => void run(async () => {
        const r = await api.confirmCarePlan(plan.id, plan.lockVersion); setPlan(r.plan); setConfirming(false); onUpdated(); setNotice('計画を確定しました')
      })}>第1〜3表を確定する</button>
      {error && <p role="alert" className="cp-error">{error}</p>}
    </Modal>}
    {aiOpen && <Modal title="保存済みアセスメントからAI原案を作る" onClose={() => { if (!busy) setAiOpen(false) }}>
      <AiDraftPanel clientId={plan.clientId} draft={aiDraft} busy={busy} onGenerate={(documentId, revisionId) => void run(async () => {
        const r = await api.carePlanAi(plan.id, documentId, revisionId); setAiDraft(r.draft)
        setPlan((old) => ({ ...old, aiDraft: r.draft }))
      })} onApply={() => void run(async () => {
        if (!aiDraft || !await first.flush()) throw new Error('第1表の入力を確認してください。')
        const r = await api.applyCarePlanAi(plan.id, aiDraft.id, plan.lockVersion)
        setPlan(r.plan); setNeeds(r.plan.needs); setSlots(r.plan.slots); await first.reload()
        setAiNeeds(new Set(r.applied.needs))
        setAiDraft({ ...aiDraft, status: 'applied' })
        const count = r.applied.fields.length + r.applied.needs.length
        setAiOpen(false)
        setNotice(count ? `AI原案を${count}項目入力しました。${r.applied.skipped.length ? `${r.applied.skipped.length}項目は入力していません。` : ''}内容を確認し、第1〜3表を保存してください。`
          : '原案は入力されませんでした。人の入力・既存の内容などを優先しています。手入力はそのまま続けられます。')
      })} />
      {error && <p role="alert" className="cp-error">{error}</p>}
    </Modal>}
  </>
}

function AiDraftPanel({ clientId, draft, busy, onGenerate, onApply }: {
  clientId: string, draft?: AiDraftDetail, busy: boolean,
  onGenerate: (documentId: string, revisionId: number) => void, onApply: () => void,
}) {
  const [sources, setSources] = useState<{ documentId: string, id: number, rev: number, savedAt: string }[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    api.client(clientId).then(async ({ client }) => {
      const groups = await Promise.all(client.documents.filter((d) => d.kind === 'assessment').map(async (d) =>
        (await api.revisions(d.id)).revisions.map((r) => ({ ...r, documentId: d.id }))))
      if (alive) setSources(groups.flat())
    }).catch((e) => { if (alive) setError(message(e)) })
    return () => { alive = false }
  }, [clientId])
  const asRecord = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const records = (v: unknown) => (Array.isArray(v) ? v : []).filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map(asRecord)
  const text = (v: unknown) => typeof v === 'string' ? v : ''
  const proposal = asRecord(draft?.proposal)
  return <>
    <p>AI原案はまだ確定した計画ではありません。参照元は保存済みの版に固定され、その後のアセスメント変更は自動反映しません。</p>
    {error && <p role="alert" className="cp-error">{error}</p>}
    <label>参照するアセスメント<select disabled={busy} value={selected} onChange={(e) => setSelected(e.target.value)}>
      <option value="">保存版を選ぶ</option>{sources.map((s, i) => <option key={s.id} value={String(i)}>保存版 {s.rev}・{new Date(s.savedAt).toLocaleString('ja-JP')}</option>)}
    </select></label>
    {!sources.length && <p>保存済みアセスメントが必要です。アセスメント画面で保存してからお試しください。</p>}
    <button className="btn" disabled={busy || selected === ''} onClick={() => { const source = sources[Number(selected)]; onGenerate(source.documentId, source.id) }}>{busy ? '処理中…' : '原案を作る'}</button>
    {draft?.status === 'failed' && <p role="alert" className="cp-error">AI原案を作れませんでした。手入力はそのまま続けられます。</p>}
    {draft && draft.status !== 'failed' && <>
      <h3>AI原案（未確定）</h3><p>参照：保存版 {draft.sourceRevisionRev}・生成日時 {new Date(draft.referencedAt).toLocaleString('ja-JP')}</p>
      {Object.entries(asRecord(proposal.plan1)).map(([key, value]) => <div className="cp-service" key={key}><strong>{key === 'plan.overallPolicy' ? '総合的な援助の方針' : key === 'plan.intentionAnalysis' ? '意向を踏まえた課題分析' : '第1表の候補'}</strong><p>{typeof value === 'string' ? value : '候補を確認してください'}</p></div>)}
      {records(proposal.needs).map((n, i) => <div className="cp-service" key={i}><strong>{text(n.need)}</strong><p>長期目標：{text(asRecord(n.longGoal).goal)}</p>{records(n.shortGoals).map((g, j) => <p key={j}>{text(g.goal)}：{records(g.services).map((s) => text(s.content)).join('、')}</p>)}</div>)}
      {records(draft.conflicts).map((conflict, i) => <p key={i} className="cp-error">確認が必要な点：{text(conflict.reason)}</p>)}
      <p>人が直した欄・既存のニーズは上書きしません。入力後も編集できます。保存・確定は別の操作です。</p>
      <button className="btn btn-p" disabled={busy || !['proposed'].includes(draft.status)} onClick={onApply}>この原案を入力する</button>
    </>}
  </>
}

type Period = { periodText?: string | null, periodFrom?: string | null, periodTo?: string | null }
function PeriodFields({ value, update, text = true }: { value: Period, update: (change: Partial<Period>) => void, text?: boolean }) {
  return <div className="cp-fields">
    {text && <label>期間の表示<input value={value.periodText ?? ''} onChange={(e) => update({ periodText: e.target.value })} placeholder="例：2026年4月〜9月" /></label>}
    <label>開始日（任意）<input type="date" value={value.periodFrom ?? ''} onChange={(e) => update({ periodFrom: e.target.value || null })} /></label>
    <label>終了日（任意）<input type="date" value={value.periodTo ?? ''} onChange={(e) => update({ periodTo: e.target.value || null })} /></label>
  </div>
}

function NeedFields({ need, update }: { need: NeedInput, update: (mutate: (need: NeedInput) => void) => void }) {
  return <>
    <label>生活全般の解決すべき課題（ニーズ）<textarea value={need.need} onChange={(e) => update((n) => { n.need = e.target.value })} /></label>
    <label>長期目標<textarea value={need.longGoal.goal} onChange={(e) => update((n) => { n.longGoal.goal = e.target.value })} /></label>
    <PeriodFields value={need.longGoal} update={(p) => update((n) => Object.assign(n.longGoal, p))} />
    {need.shortGoals?.map((goal, j) => <section className="cp-goal" key={goal.id ?? j}>
      <label>短期目標 {j + 1}<textarea value={goal.goal} onChange={(e) => update((n) => { n.shortGoals![j].goal = e.target.value })} /></label>
      <PeriodFields value={goal} update={(p) => update((n) => Object.assign(n.shortGoals![j], p))} />
      {goal.services?.map((s, k) => <section className="cp-service" key={s.id ?? k}>
        <label>サービス内容<input value={s.content} onChange={(e) => update((n) => { n.shortGoals![j].services![k].content = e.target.value })} /></label>
        <div className="cp-fields">{(['kind', 'provider', 'frequency'] as const).map((key, i) => <label key={key}>{['サービス種別', '提供事業所', '頻度'][i]}<input value={s[key] ?? ''} onChange={(e) => update((n) => { n.shortGoals![j].services![k][key] = e.target.value })} /></label>)}</div>
        <label className="cp-check"><input type="checkbox" checked={s.insured ?? true} onChange={(e) => update((n) => { n.shortGoals![j].services![k].insured = e.target.checked })} />保険給付の対象</label>
        <PeriodFields value={s} update={(p) => update((n) => Object.assign(n.shortGoals![j].services![k], p))} />
        <button className="btn cp-danger" onClick={() => update((n) => { n.shortGoals![j].services!.splice(k, 1) })}>サービスを削除</button>
      </section>)}
      <button className="btn" onClick={() => update((n) => { (n.shortGoals![j].services ??= []).push({ content: '', insured: true }) })}>＋ サービスを追加</button>
      <button className="btn cp-danger" onClick={() => update((n) => { n.shortGoals!.splice(j, 1) })}>短期目標を削除</button>
    </section>)}
    <button className="btn" onClick={() => update((n) => { (n.shortGoals ??= []).push({ goal: '', services: [] }) })}>＋ 短期目標を追加</button>
  </>
}
