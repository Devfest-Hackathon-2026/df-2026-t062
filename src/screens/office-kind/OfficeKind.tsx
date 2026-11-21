// 責任者の画面（#102）: 書類の画面（書式）。
import { useEffect, useState } from 'react'
import { api } from '../../lib/api.ts'
import { linkProps, navigate } from '../../lib/router.tsx'
import { BackLink, Icon, OfficeShell } from '../../components/office-shell/OfficeShell.tsx'
import { day, dismiss, failText, phaseOf, useOfficeForms } from '../../components/form-status/formStatus.ts'

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
