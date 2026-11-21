// 責任者の画面（#102）: 左のメニュー、書類の設定（一覧）、書類の画面（書式）、書式を上げる。
// #111 で採用した試作（prototypes/111-admin-adopted）の並びと言葉を、本番の部品に合わせたもの。
// 責任者には、裏側の言葉（様式・版・対応など）を見せない。「AI に事業所のやり方を教える」は #154 で決まるまで出さない。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, type KindFormState } from '../lib/api.ts'
import { linkProps, navigate } from '../lib/router.tsx'
import { upload } from '../form/recordingUpload.ts'
import { PcHeader } from '../components/Chrome.tsx'
import './office.css'

// ---------- 小さな部品 ----------

const Icon = {
  doc: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>,
  arc: <svg className="of-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" /></svg>,
  upload: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>,
  back: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>,
}

export function BackLink({ to, label }: { to: string, label: string }) {
  return <a className="of-back" {...linkProps(to)}>{Icon.back}{label}</a>
}

/** 責任者の外枠: 上の帯と左のメニュー。wide は余白なし（書式を見る画面） */
export function OfficeShell({ staffName, active, wide, children }: { staffName: string, active: 'forms' | 'clients' | null, wide?: boolean, children: ReactNode }) {
  return (
    <div className={`pc${wide ? ' of-wide' : ''}`} style={{ fontFamily: "'Noto Sans JP',system-ui,sans-serif", color: '#1F2430', background: '#F4F5F7', minHeight: '100vh', fontSize: 14, lineHeight: 1.6 }}>
      <PcHeader staffName={staffName} roleLabel="責任者" />
      {wide ? <main className="of-wide-main">{children}</main> : (
        <div className="of-app">
          <nav className="of-nav" aria-label="メニュー">
            <a {...linkProps('/')} aria-current={active === 'clients' ? 'page' : undefined}>{Icon.users}利用者一覧</a>
            <a {...linkProps('/office')} aria-current={active === 'forms' ? 'page' : undefined}>{Icon.doc}書類の設定</a>
          </nav>
          <main className="of-main">{children}</main>
        </div>
      )}
    </div>
  )
}

/** 書類ごとの書式の様子を読み、読み取り中は数秒おきに読み直す */
function useOfficeForms() {
  const [kinds, setKinds] = useState<KindFormState[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      setKinds((await api.officeForms()).kinds)
      setError('')
    } catch (e) { setError(String((e as Error).message)) }
  }, [])
  useEffect(() => { void load() }, [load])
  const reading = (kinds ?? []).some((k) => readingOf(k))
  useEffect(() => {
    if (!reading) return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [reading, load])
  return { kinds, error, reload: load, setKinds }
}

const readingOf = (k: KindFormState) => !!k.import && k.import.uploaded && (k.import.status === 'queued' || k.import.status === 'processing')

/** 書類の画面の上に出す様子。取り込みが下書きより新しいときだけ、取り込みの様子を出す */
type Phase = 'reading' | 'failed' | 'same' | 'review' | 'empty' | 'fixing' | null
function phaseOf(k: KindFormState): Phase {
  const imp = k.import && k.import.uploaded ? k.import : null
  if (imp && readingOf(k)) return 'reading'
  const draftAt = k.draft ? Date.parse(k.draft.createdAt) : 0
  if (imp && imp.status === 'failed' && Date.parse(imp.updatedAt) >= draftAt) return 'failed'
  if (imp && imp.status === 'matched' && Date.parse(imp.updatedAt) >= draftAt && !dismissed(imp.id)) return 'same'
  if (k.draft) return k.draft.fromImport ? (k.draft.empty ? 'empty' : 'review') : 'fixing'
  return null
}

const DISMISS_KEY = 'careman.office.dismissed'
function dismissed(importId: string): boolean {
  try { return (JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as string[]).includes(importId) } catch { return false }
}
function dismiss(importId: string) {
  try {
    const list = (JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as string[]).filter((x) => x !== importId)
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...list.slice(-50), importId]))
  } catch { /* 覚えられなくても、閉じるだけ */ }
}

/** 読めなかった理由（責任者の言葉で） */
export function failText(kind: string | null): { title: string, text: string } {
  switch (kind) {
    case 'no_text': return { title: '読み取れませんでした', text: '紙を写真やスキャンにした PDF のようです。Word や Excel から PDF に書き出して、上げ直してください。' }
    case 'encrypted': return { title: '読み取れませんでした', text: 'パスワードのかかった PDF は読めません。パスワードを外してから上げ直してください。' }
    case 'too_large': return { title: 'PDF が大きすぎます', text: '20MB までの PDF を上げてください。' }
    case 'too_many_pages': return { title: 'ページが多すぎます', text: 'ページの少ない PDF に分けられないか確かめてください。' }
    case 'invalid_pdf': case 'unsafe_pdf': return { title: '読み取れませんでした', text: 'PDF として開けませんでした。Word や Excel から PDF に書き出して、上げ直してください。' }
    default: return { title: '読み取れませんでした', text: 'うまく読み取れませんでした。少し待ってから、もう一度上げてください。' }
  }
}

const day = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

// ---------- 書類の設定（一覧） ----------

export function OfficeForms({ staffName }: { staffName: string }) {
  const { kinds, error } = useOfficeForms()
  return (
    <OfficeShell staffName={staffName} active="forms">
      <div className="of-list">
        <h1 className="of-h1">書類の設定</h1>
        <p className="of-lead" style={{ marginTop: 0 }}>書類ごとに、事業所でいつも使っている書式（PDF）を上げると、その形で書類を作れます。</p>
        {error && <div role="alert" className="of-err">読み込めませんでした（{error}）</div>}
        {!error && !kinds && <div role="status" className="of-muted">読み込んでいます</div>}
        {kinds && (
          <div className="of-rows">
            {kinds.map((k) => {
              const p = phaseOf(k)
              const notice = p === 'review' ? ['', k.draft!.review.length ? '上げた書式に、AI が迷った欄があります' : '上げた書式を読み取りました。確かめてください']
                : p === 'reading' ? ['muted', '上げた書式を読み取っています']
                  : p === 'failed' || p === 'empty' ? ['danger', '上げた書式を読み取れませんでした']
                    : p === 'fixing' ? ['', '書式を直している途中です'] : null
              return (
                <a key={k.key} className="of-row" {...linkProps(`/office/forms/${encodeURIComponent(k.key)}`)}>
                  <div>
                    <span className="of-row-name">{k.name}</span>
                    {notice && <span className={`of-notice ${notice[0]}`}>{notice[1]}</span>}
                    <div className="of-row-sub">{k.current?.office ? `事業所の書式（${day(k.current.since)} から）` : '最初から入っている書式'}</div>
                  </div>
                  <span className="of-chev" aria-hidden="true">›</span>
                </a>
              )
            })}
          </div>
        )}
      </div>
    </OfficeShell>
  )
}

// ---------- 書類の画面（書式） ----------

type Confirm = { type: 'revert' } | { type: 'reuse', versionId: string } | null

export function OfficeKind({ staffName, kind }: { staffName: string, kind: string }) {
  const { kinds, error, setKinds, reload } = useOfficeForms()
  const [thumb, setThumb] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const k = kinds?.find((x) => x.key === kind)
  const currentId = k?.current?.versionId

  useEffect(() => {
    setThumb(null)
    if (!currentId) return
    let live = true
    api.managedAssets(currentId).then((a) => { if (live) setThumb(a.pages[0]?.url ?? null) }).catch(() => {})
    return () => { live = false }
  }, [currentId])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setActionError('')
    try { await fn() } catch (e) { setActionError(String((e as Error).message)) } finally { setBusy(false) }
  }
  const fix = () => run(async () => {
    const r = await api.fixDraft(currentId!)
    navigate(`/office/forms/${encodeURIComponent(kind)}/review/${r.formVersion.id}?fix=1`)
  })
  const doConfirm = () => run(async () => {
    if (confirm?.type === 'revert') setKinds((await api.revertForm(kind)).kinds)
    else if (confirm?.type === 'reuse') { await api.reuseForm(confirm.versionId); await reload() }
    setConfirm(null)
  })

  if (!kinds) {
    return <OfficeShell staffName={staffName} active="forms"><BackLink to="/office" label="書類の設定" />{error ? <div role="alert" className="of-err">読み込めませんでした（{error}）</div> : <div role="status" className="of-muted">読み込んでいます</div>}</OfficeShell>
  }
  if (!k) {
    return <OfficeShell staffName={staffName} active="forms"><BackLink to="/office" label="書類の設定" /><h1 className="of-h1">この書類はありません</h1></OfficeShell>
  }

  const office = !!k.current?.office
  const phase = phaseOf(k)
  const base = `/office/forms/${encodeURIComponent(k.key)}`
  const fail = phase === 'failed' ? failText(k.import!.errorKind)
    : phase === 'empty' ? { title: '書く欄を見つけられませんでした', text: 'この書式は使えません。Word や Excel から書き出した PDF を、上げ直してください。' } : null
  return (
    <OfficeShell staffName={staffName} active="forms">
      <BackLink to="/office" label="書類の設定" />
      <h1 className="of-h1">{k.name}</h1>
      <section className="of-panel" aria-label="書式">
        <h2>書式</h2>
        <div className="of-paper">
          {thumb ? <img src={thumb} alt={`${k.name}の書式の 1 ページ目`} /> : <div className="of-thumb" aria-hidden="true"><span style={{ width: '60%', background: '#B8C0CC', border: 0 }} /><span /><span /><span style={{ height: 40 }} /><span /><span style={{ height: 50 }} /></div>}
        </div>
        <div className="of-pill-row">
          <span className={`of-pill ${office ? 'office' : 'builtin'}`}>{office ? '事業所の書式' : '最初の書式'}</span>
          {office && k.current?.since && <span className="of-muted">{day(k.current.since)} から</span>}
        </div>
        {phase === 'reading' && <div className="of-state info" role="status">{Icon.arc}<span>上げた書式を読み取っています<small>数分かかります。この画面を離れても続きます。そのあいだも、今の書式で書類を作れます。</small></span></div>}
        {phase === 'review' && <div className="of-state warn">{Icon.alert}<span>{k.draft!.review.length ? 'AI が迷った欄があります' : '読み取りが終わりました。確かめてください'}</span><a className="btn btn-p btn-s" {...linkProps(`${base}/review/${k.draft!.versionId}`)}>見る</a></div>}
        {phase === 'fixing' && <div className="of-state warn">{Icon.alert}<span>書式を直している途中です</span><a className="btn btn-p btn-s" {...linkProps(`${base}/review/${k.draft!.versionId}?fix=1`)}>続ける</a></div>}
        {fail && <div className="of-state danger" role="alert">{Icon.alert}<span>{fail.title}<small>{fail.text}</small></span><a className="btn btn-s" {...linkProps(`${base}/upload`)}>上げ直す</a></div>}
        {phase === 'same' && <div className="of-state ok">{Icon.check}<span>最初の書式と同じでした<small>替えなくても、このまま使えます。</small></span><button type="button" className="btn btn-s" onClick={() => { dismiss(k.import!.id); setKinds([...kinds]) }}>閉じる</button></div>}
        <div className="of-actions">
          {office && phase !== 'reading' && <button type="button" className="btn" disabled={busy} onClick={() => void fix()}>直す</button>}
          {office && phase !== 'reading' && <button type="button" className="btn-l btn" onClick={() => setConfirm({ type: 'revert' })}>最初の書式に戻す</button>}
          {!office && k.shelved && phase !== 'reading' && <button type="button" className="btn" onClick={() => setConfirm({ type: 'reuse', versionId: k.shelved!.versionId })}>事業所の書式に戻す</button>}
          {phase !== 'reading' && <a className={office || k.shelved ? 'btn-l btn' : 'btn'} {...linkProps(`${base}/upload`)}>{Icon.upload}{office ? '事業所の書式を上げ直す' : '事業所の書式を上げる'}</a>}
        </div>
        {actionError && <div role="alert" className="of-err">できませんでした（{actionError}）</div>}
      </section>
      {confirm && (
        <>
          <div className="of-modal-back" onClick={() => setConfirm(null)} />
          <section className="of-modal" role="dialog" aria-modal="true" aria-labelledby="of-md-h">
            {confirm.type === 'revert' ? (
              <>
                <h2 id="of-md-h">最初から入っている書式に戻しますか？</h2>
                <p>これから作る{k.name}は、最初から入っている書式になります。</p>
                <div className="gray">今ある{k.name}は、<strong>作ったときの書式のまま</strong>です。事業所で上げた書式は残るので、あとでまた替えられます。</div>
              </>
            ) : (
              <>
                <h2 id="of-md-h">事業所の書式に戻しますか？</h2>
                <p>これから作る{k.name}は、前に使っていた事業所の書式になります。</p>
                <div className="gray">今ある{k.name}は、<strong>作ったときの書式のまま</strong>です。</div>
              </>
            )}
            <div className="of-modal-btns">
              <button type="button" className="btn" onClick={() => setConfirm(null)}>戻る</button>
              <button type="button" className="btn btn-p" disabled={busy} onClick={() => void doConfirm()}>戻す</button>
            </div>
          </section>
        </>
      )}
    </OfficeShell>
  )
}

// ---------- 書式を上げる ----------

const MAX_BYTES = 20 * 1024 * 1024

export function OfficeUpload({ staffName, kind }: { staffName: string, kind: string }) {
  const { kinds } = useOfficeForms()
  const k = kinds?.find((x) => x.key === kind)
  const [file, setFile] = useState<File | null>(null)
  const [over, setOver] = useState(false)
  const [pct, setPct] = useState<number | null>(null)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const back = `/office/forms/${encodeURIComponent(kind)}`
  const name = k?.name ?? ''

  const pick = (f: File | undefined | null) => {
    setError('')
    if (!f) return
    if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) { setError('PDF だけ上げられます。'); return }
    if (f.size > MAX_BYTES) { setError('20MB までの PDF を上げてください。'); return }
    setFile(f)
  }
  const go = async () => {
    if (!file) return
    setError('')
    setPct(0)
    try {
      const r = await api.startFormImport(kind)
      if (r.uploadUrl && await upload(r.uploadUrl, file, setPct) === 'expired') throw new Error('送れませんでした。もう一度上げてください')
      await api.completeFormImport(r.import.id)
      navigate(back)
    } catch (e) {
      setPct(null)
      setError(e instanceof ApiError ? e.message : String((e as Error).message))
    }
  }

  return (
    <OfficeShell staffName={staffName} active="forms">
      <BackLink to={back} label={name || '戻る'} />
      <div className="of-upload">
        <h1 className="of-h1">事業所の書式を上げる</h1>
        <p className="of-lead">いつも使っている{name}の書式（PDF）を上げると、その形で書類を作れます。</p>
        <h2 style={{ margin: '24px 0 0', fontSize: 16 }}>上げる前に</h2>
        <div className="of-conds">
          <div className="of-cond"><h3>何も書き込んでいない書式</h3><p>記入済みのものを上げると、利用者の情報がこのサービスに残ってしまいます。</p></div>
          <div className="of-cond"><h3>Word や Excel から PDF に書き出したもの</h3><p>紙をスキャンしたものや写真は、線や □ を正しく読み取れないことがあります。</p></div>
          <div className="of-cond"><h3>全部のページ</h3><p>上げなかったページは印刷されません。1 つの PDF にまとめて上げてください。</p></div>
        </div>
        <div
          className={`of-drop${over ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]) }}
        >
          {Icon.upload}
          <strong>書式の PDF をここに置く</strong>
          <button type="button" className="btn" onClick={() => input.current?.click()}>ファイルを選ぶ</button>
          <input ref={input} type="file" accept="application/pdf" className="sr" tabIndex={-1} aria-label="書式の PDF を選ぶ" onChange={(e) => pick(e.target.files?.[0])} />
          <div className="of-muted">PDF だけ上げられます（20MB まで）</div>
        </div>
        <div className="of-file-row">
          <div className="main">
            {file ? <><div className="of-file-name">{file.name}</div><div className="of-muted">{(file.size / 1024 / 1024).toFixed(1)} MB</div></> : !error && <div className="of-muted">まだ PDF を選んでいません</div>}
            {error && <div role="alert" className="of-err">{error}</div>}
          </div>
          <a className="btn" {...linkProps(back)}>やめる</a>
          <button type="button" className="btn btn-p" disabled={!file || pct !== null} onClick={() => void go()}>{pct !== null ? `送っています（${pct}%）` : '上げて読み取る'}</button>
        </div>
        <p className="of-muted" style={{ marginTop: 12 }}>読み取りには数分かかります。そのあいだも、今の書式で書類を作れます。</p>
      </div>
    </OfficeShell>
  )
}
