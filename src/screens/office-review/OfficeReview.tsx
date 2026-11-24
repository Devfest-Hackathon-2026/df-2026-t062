// 責任者の画面（#102）: 上げた書式の読み取り結果を見る（AI が迷った欄を確かめる）・使っている書式を直す。
// 用紙の画像の上に、印字欄ごとに「入る内容」を出す。欄を押すと「ここには〇〇が入ると思います。合っていますか？」と聞く。
// 違うときは、何が入るかを言葉で書いてもらい、サーバーが fields.json の欄か、その書式だけの欄に当てはめる（責任者には欄の key を見せない）。
// 「合っています」にした欄は、この下書きの間だけ、このブラウザに覚える。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { api, ApiError, type KindFormState, type ManagedVersion } from '../../lib/api.ts'
import { navigate } from '../../lib/router.tsx'
import { SlotGeometryEditor } from './SlotGeometryEditor.tsx'
import type { SlotGeometry } from '../../../core/slot-geometry.ts'
import { BackLink, OfficeShell } from '../../components/office-shell/OfficeShell.tsx'
import { AddPublishDialog, AddSteps } from '../../components/office-add/AddSteps.tsx'
import { adding, reviewSlotNames } from '../../components/office-add/addFlow.ts'

interface SlotBox { name: string, x: number, y: number, w: number, h: number, pt: number, mark: boolean, area: boolean }

const doneKey = (id: string) => `careman.office.done.${id}`
function loadDone(id: string): Record<string, string> {
  try { return JSON.parse(sessionStorage.getItem(doneKey(id)) ?? '{}') as Record<string, string> } catch { return {} }
}
function saveDone(id: string, d: Record<string, string>) {
  try { sessionStorage.setItem(doneKey(id), JSON.stringify(d)) } catch { /* 覚えられなくても、この画面の中では使える */ }
}

type Pop = { mode: 'ask' } | { mode: 'teach' } | { mode: 'confirm' }

export function OfficeReview({ staffName, kind, versionId, fix }: { staffName: string, kind: string, versionId: string, fix: boolean }) {
  const [v, setV] = useState<ManagedVersion | null>(null)
  const [images, setImages] = useState<Record<number, string | null>>({})
  const [kindName, setKindName] = useState('')
  // 事業所の書類を足している途中（#153）の種類。手順 3 として出し、最後は手順 4（使い始める）へ。録音から書く項目は、使い始めるときにサーバーで AI が決める（#209）
  const [addKind, setAddKind] = useState<KindFormState | null>(null)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(100)
  const [sel, setSel] = useState<string | null>(null)
  const [pop, setPop] = useState<Pop>({ mode: 'ask' })
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [slotError, setSlotError] = useState('')
  // 確かめ済みの欄（印字欄の名前 → そのときの入る内容）。直した欄（fix）も同じところに覚える
  const [done, setDone] = useState<Record<string, string>>(() => loadDone(versionId))
  const [unused, setUnused] = useState<string[]>([])
  const [moved, setMoved] = useState<Record<string,string>>(() => loadDone(versionId + '.positions'))
  const [publishing, setPublishing] = useState<'ask' | 'busy' | null>(null)
  const [publishError, setPublishError] = useState('')
  const back = `/office/forms/${encodeURIComponent(kind)}`
  const scroll = useRef<HTMLDivElement>(null)

  useEffect(() => { saveDone(versionId, done) }, [versionId, done])
  useEffect(() => { saveDone(versionId + '.positions', moved) }, [versionId, moved])
  // 選んだ欄が見えるところまで用紙を動かす（右の一覧から選んだとき）
  useEffect(() => {
    if (!sel) return
    const t = setTimeout(() => scroll.current?.querySelector(`[data-slot="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }), 0)
    return () => clearTimeout(t)
  }, [sel, page])
  useEffect(() => {
    let live = true
    Promise.all([api.managedVersion(versionId), api.managedAssets(versionId), api.officeForms()])
      .then(([mv, assets, forms]) => {
        if (!live) return
        setV(mv)
        setImages(Object.fromEntries(assets.pages.map((p) => [p.no, p.url])))
        const k = forms.kinds.find((x) => x.key === kind)
        setKindName(k?.name ?? '')
        setAddKind(k && adding(k) ? k : null)
        if (!fix && mv.review[0]) {
          setSel(mv.review[0].slot)
          setPage(pageOfSlot(mv, mv.review[0].slot) ?? 1)
        }
      })
      .catch((e) => { if (live) setError(String((e as Error).message)) })
    return () => { live = false }
  }, [versionId, kind, fix])

  const boxes = useMemo(() => {
    const out = new Map<number, SlotBox[]>()
    if (!v) return out
    for (const p of v.formVersion.pages) {
      out.set(p.no, (v.formVersion.schemas[p.pdfIndex] ?? []).map((s) => {
        const b = v.formVersion.bindings[s.name]
        return { name: s.name, x: s.position.x, y: s.position.y, w: s.width, h: s.height, pt: (s as { fontSize?: number }).fontSize ?? 9, mark: b?.ui === 'check' || b?.ui === 'circle' || s.type === 'circleMark', area: b?.ui === 'area' }
      }))
    }
    return out
  }, [v])

  const reviewSlots = useMemo(() => (fix || !v ? [] : reviewSlotNames(v.review)), [v, fix])
  const pageWarnings = useMemo(
  () => (fix || !v ? [] : v.review.filter((item) => !item.slot.trim())),
  [v, fix]
)
  const exists = useCallback((name: string) => !!v && v.formVersion.schemas.some((p) => p.some((s) => s.name === name)), [v])
  const isDone = (name: string) => name in done || unused.includes(name) || (fix && name in moved)
  const open = reviewSlots.filter((n) => !isDone(n))
  const finished = fix ? [...new Set([...Object.keys(done), ...Object.keys(moved), ...unused])] : reviewSlots.filter((n) => isDone(n)).concat(unused.filter((n) => !reviewSlots.includes(n)))
  const noSlots = !!v && !v.formVersion.schemas.some((p) => p.length)
  const ready = !noSlots && (fix ? finished.length > 0 : open.length === 0)
  const what = (name: string) => (unused.includes(name) && !exists(name) ? '何も入れない' : v?.slots[name]?.what ?? '（まだ決まっていません）')
  const labelOf = (name: string) => `「${name.replace(/^p\d+_/, '').replace(/_/g, ' ')}」の欄`

  const select = (name: string) => {
    setSel(name)
    setSlotError('')
    setTyped('')
    setPop({ mode: 'ask' })
    const p = v ? pageOfSlot(v, name) : null
    if (p) setPage(p)
  }

  const teach = async () => {
    if (!v || !sel) return
    const text = typed.trim()
    if (!text) { setSlotError('何が入るかを書いてください。'); return }
    setBusy(true)
    setSlotError('')
    try {
      const r = await api.teachSlot(versionId, sel, v.formVersion.contentSha, text)
      setV(r)
      setDone((d) => { const n = { ...d }; delete n[sel]; return n })
      setPop({ mode: 'confirm' })
    } catch (e) {
      setSlotError(e instanceof ApiError && e.status === 409 ? 'ほかの人が先に直しました。画面を読み直してください。' : `直せませんでした（${(e as Error).message}）`)
    } finally { setBusy(false) }
  }
  const move = async (name: string, box: SlotGeometry) => {
    if (!v) return
    setBusy(true)
    try {
      const schemas = v.formVersion.schemas.map(p => p.map(s => s.name === name ? { ...s, position: { x: box.x, y: box.y }, width: box.w, height: box.h } : s))
      setV(await api.positionSlots(versionId, v.formVersion.contentSha, schemas))
      setMoved(old => ({...old, [name]: what(name)}))
    } catch (e) {
      throw new Error(e instanceof ApiError && e.status === 409 ? 'ほかの人が先に直しました。画面を読み直してください。' : '位置を保存できませんでした。入力は残しています。')
    } finally { setBusy(false) }
  }
  const markUnused = async () => {
    if (!v || !sel) return
    setBusy(true)
    setSlotError('')
    try {
      const r = await api.unusedSlot(versionId, sel, v.formVersion.contentSha)
      setV(r)
      setUnused((u) => [...u.filter((x) => x !== sel), sel])
      setDone((d) => { const n = { ...d }; delete n[sel]; return n })
      setSel(null)
    } catch (e) {
      setSlotError(`直せませんでした（${(e as Error).message}）`)
    } finally { setBusy(false) }
  }
  const ok = () => {
    if (!sel) return
    setDone((d) => ({ ...d, [sel]: what(sel) }))
    // 次のまだの欄へ
    const next = open.find((n) => n !== sel)
    if (next) select(next)
    else setSel(null)
  }

  const publish = async () => {
    if (!v) return
    setPublishing('busy')
    setPublishError('')
    try {
      await api.publishVersion(versionId, v.formVersion.contentSha)
      try { sessionStorage.removeItem(doneKey(versionId)) } catch { /* なくてもよい */ }
      navigate(addKind ? '/office' : back)
    } catch (e) {
      setPublishing('ask')
      setPublishError(e instanceof ApiError && e.status === 422 ? 'まだ使い始められません。書式の中に、何が入るか決まっていない欄があります。' : `使い始められませんでした（${(e as Error).message}）`)
    }
  }

  const head = addKind ? (
    <>
      <AddSteps step={3} name={kindName} />
      <header className="of-focus-head" style={{ paddingTop: 8, paddingBottom: 8 }}><BackLink to={`${back}/upload`} label="書式を上げる" /><h1>書式の読み取り結果</h1></header>
    </>
  ) : (
    <header className="of-focus-head">
      <BackLink to={back} label={kindName || '書類に戻る'} />
      <h1>{fix ? '書式を直す' : '書式の読み取り結果'}</h1>
    </header>
  )
  if (!v) {
    return <OfficeShell staffName={staffName} active={null} wide>{head}<div style={{ padding: 24 }}>{error ? <div role="alert" className="of-err">読み込めませんでした（{error}）</div> : <div role="status" className="of-muted">読み込んでいます</div>}</div></OfficeShell>
  }
  if (v.formVersion.status !== 'draft') {
    return <OfficeShell staffName={staffName} active={null} wide>{head}<div style={{ padding: 24 }}><p style={{ margin: '0 0 12px' }}>この書式は、もう使い始めています。直すときは、書類の画面の「直す」から開いてください。</p><button type="button" className="btn btn-p" onClick={() => navigate(back)}>書類の画面に戻る</button></div></OfficeShell>
  }

  const pages = v.formVersion.pages
  const current = pages.find((p) => p.no === page) ?? pages[0]
  const countOn = (no: number) => open.filter((n) => pageOfSlot(v, n) === no).length
  const slotStyle = (b: SlotBox): CSSProperties => ({ left: `${b.x/current.width*100}%`, top: `${b.y/current.height*100}%`, width: `${b.w/current.width*100}%`, height: `${b.h/current.height*100}%`, fontSize: b.mark ? undefined : `${Math.min(b.pt,10)*.3528/current.width*100}cqw` })

  const popFor = (b: SlotBox) => {
    const m = v.slots[b.name]
    const below = b.y + b.h + 2
    const style: CSSProperties = { left: `${Math.min(b.x, Math.max(0,current.width - 100)) / current.width * 100}%`, ...(below < current.height - 65 ? { top: `${below / current.height * 100}%` } : { bottom: `${(current.height - b.y + 2) / current.height * 100}%` }) }
    const doneHere = b.name in done && pop.mode === 'ask'
    return (
      <div className="of-pop" role="dialog" aria-label="この欄に入るもの" style={style} onClick={(e) => e.stopPropagation()}>
        {pop.mode === 'teach' ? (
          <>
            <label>{m?.mark ? 'どんなときに印を付けますか？' : 'ここに何が入りますか？'}
              <input autoFocus value={typed} placeholder={m?.mark ? '例: 介護保険の負担割合が 1 割のとき' : '例: 緊急連絡先の電話番号'} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void teach() }} disabled={busy} />
            </label>
            <div className="of-pop-btns">
              <button type="button" className="btn btn-p" style={{ flex: '0 0 auto' }} disabled={busy} onClick={() => void teach()}>{busy ? '考えています…' : '教える'}</button>
              <button type="button" className="btn btn-l" style={{ flex: '0 0 auto' }} disabled={busy} onClick={() => void markUnused()}>この欄は使っていない</button>
            </div>
          </>
        ) : doneHere ? (
          <div className="of-pop-done"><span>✓ {what(b.name)}</span>{fix
            ? <button type="button" className="btn btn-s" onClick={() => { setTyped(''); setPop({ mode: 'teach' }) }}>もう一度直す</button>
            : <button type="button" className="btn btn-s" onClick={() => setDone((d) => { const n = { ...d }; delete n[b.name]; return n })}>やり直す</button>}</div>
        ) : fix && pop.mode === 'ask' ? (
          <>
            <p>{sentence(m, 'is')}</p>
            <div className="of-pop-btns">
              <button type="button" className="btn" onClick={() => { setTyped(''); setPop({ mode: 'teach' }) }}>違うので直す</button>
              <button type="button" className="btn btn-l" onClick={() => setSel(null)}>閉じる</button>
            </div>
          </>
        ) : (
          <>
            <p>{sentence(m, pop.mode === 'confirm' ? 'confirm' : 'guess')}</p>
            <div className="of-pop-btns">
              <button type="button" className="btn btn-p" onClick={ok}>合っています</button>
              <button type="button" className="btn" onClick={() => { setTyped(''); setPop({ mode: 'teach' }) }}>違います</button>
            </div>
          </>
        )}
        <SlotGeometryEditor key={`${b.name}:${v.formVersion.contentSha}`} box={{ x:b.x, y:b.y, w:b.w, h:b.h }} page={current} disabled={busy} onSave={box=>move(b.name,box)} />
        {slotError && <div role="alert" className="of-err">{slotError}</div>}
      </div>
    )
  }

  return (
    <OfficeShell staffName={staffName} active={null} wide>
      {head}
      <div className="of-review">
        <nav className="of-rail" aria-label="ページ">
          <div className="of-rail-label">ページ</div>
          {pages.map((p) => {
            const c = countOn(p.no)
            return (
              <button key={p.no} type="button" aria-pressed={p.no === current.no} aria-label={`${p.no} ページ${c ? `（まだの欄 ${c} か所）` : ''}`} onClick={() => { setPage(p.no); setSel(null); scroll.current?.scrollTo({ top: 0 }) }}>
                {p.no}{c > 0 && <span className="cnt">{c}</span>}
              </button>
            )
          })}
        </nav>
        <section className="of-paper-area" aria-label="書式">
          <div className="of-tools">
            <span className="hint">{fix ? 'ずれている欄を押すと、入る内容や位置・大きさを直せます。' : '色の付いた欄を押すと、何が入るかを確かめられます。ほかの欄も押して直せます。'}</span>
            <span className="of-zoom">
              <button type="button" className="btn btn-s btn-i" aria-label="小さくする" onClick={() => setZoom((z) => Math.max(60, z - 10))}>−</button>
              <span>{zoom}%</span>
              <button type="button" className="btn btn-s btn-i" aria-label="大きくする" onClick={() => setZoom((z) => Math.min(200, z + 10))}>＋</button>
            </span>
          </div>
          <div className="of-scroll" ref={scroll} onClick={() => setSel(null)}>
            <div className="of-sheet" style={{ width: `${Math.round(7.2 * zoom)}px`, maxWidth: 'none' }}>
              <div className="pg" style={{aspectRatio:`${current.width}/${current.height}`}}>
                {images[current.no] ? <img className="pimg" src={images[current.no]!} alt={`${current.no} ページ`} style={{aspectRatio:`${current.width}/${current.height}`}} draggable={false} /> : <div className="pimg" style={{aspectRatio:`${current.width}/${current.height}`}} role="img" aria-label={`${current.no} ページ`} />}
                {(boxes.get(current.no) ?? []).map((b) => {
                  const doubt = reviewSlots.includes(b.name) && !isDone(b.name)
                  const cls = ['of-slot', b.mark ? 'mark' : '', b.area ? 'area' : '', sel === b.name ? 'sel' : doubt ? 'doubt' : isDone(b.name) ? 'done' : ''].filter(Boolean).join(' ')
                  return (
                    <span key={b.name}>
                      <button type="button" data-slot={b.name} className={cls} style={slotStyle(b)} aria-label={`${labelOf(b.name)}（${v.slots[b.name]?.what ?? ''}）${doubt ? '。AI が迷った欄' : ''}`} onClick={(e) => { e.stopPropagation(); select(b.name) }}>
                        {b.mark ? '' : v.slots[b.name]?.what ?? ''}
                      </button>
                      {sel === b.name && popFor(b)}
                    </span>
                  )
                })}
              </div>
            </div>
          </div>
        </section>
        <aside className="of-side" aria-label={fix ? '直した欄' : 'AI が迷った欄'}>
          {pageWarnings.length > 0 && (
  <div role="alert" className="of-err" style={{ marginBottom: 12 }}>
    <strong>書式の読み取りに関する注意</strong>
    <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
      {pageWarnings.map((item, i) => (
        <li key={i}>{item.reason}</li>
      ))}
    </ul>
    <p style={{ margin: '8px 0 0' }}>
      読み取れなかった部分がないか、書式を確認してください。
    </p>
  </div>
)}
          <div className="of-cat">
            <img src={ready && !fix ? '/assistant/pet-cat.jpg' : '/assistant/pet-peeking.png'} alt="" />
            <div className="of-bubble">
              {noSlots ? <><strong>書く欄を見つけられませんでした</strong>この書式は使い始められません。Word や Excel から書き出した PDF を、上げ直してください。</>
                : fix ? <><strong>ずれている欄を押して、直してください</strong>直した書式は、これから作る書類から使います</>
                : ready ? <><strong>全部そろいました</strong>この書式で{kindName}を作れます。</>
                  : <><strong>自信がないところがあります</strong>合っているか、見てください</>}
            </div>
          </div>
          {!fix && (
            <>
              <div className="of-side-label">まだ（{open.length}）</div>
              {open.map((n) => <button key={n} type="button" className="of-side-item" aria-current={sel === n} onClick={() => select(n)}><span className="dot" aria-hidden="true" />{labelOf(n)}</button>)}
              {!open.length && !noSlots && <div className="of-side-msg" style={{ color: '#0F6249', fontWeight: 700 }}>残りはありません。使い始められます。</div>}
            </>
          )}
          <div className="of-side-label">{fix ? `直した欄（${finished.length}）` : `済み（${finished.length}）`}</div>
          {finished.map((n) => (
            <button key={n} type="button" className="of-side-item" aria-current={sel === n} disabled={!exists(n)} onClick={() => select(n)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
              <span>{labelOf(n)}<span className="of-muted" style={{ display: 'block', fontWeight: 400 }}>{what(n)}</span></span>
            </button>
          ))}
          {!finished.length && <div className="of-side-msg">{fix ? 'まだありません。' : '「合っています」にした欄と、自分で直した欄が並びます。'}</div>}
          <div className="of-side-foot">
            <button type="button" className="btn btn-p" disabled={!ready} onClick={() => setPublishing('ask')}>{addKind ? '次へ（使い始める）' : fix ? '直した書式を使い始める' : 'この書式を使い始める'}</button>
          </div>
        </aside>
      </div>
      {publishing && addKind && <AddPublishDialog name={kindName} busy={publishing === 'busy'} error={publishError} onCancel={() => setPublishing(null)} onOk={() => void publish()} />}
      {publishing && !addKind && (
        <>
          <div className="of-modal-back" onClick={() => publishing === 'ask' && setPublishing(null)} />
          <section className="of-modal" role="dialog" aria-modal="true" aria-labelledby="of-pub-h">
            <h2 id="of-pub-h">{fix ? '直した書式を使い始めますか？' : 'この書式を使い始めますか？'}</h2>
            <p>これから作る{kindName}は、{fix ? '直した書式' : '事業所で上げた書式'}になります。</p>
            <div className="gray">今ある{kindName}は、<strong>作ったときの書式のまま</strong>です。書き直したり、欄の中身が変わったりはしません。</div>
            <p className="of-muted">使い始めたあとにずれを見つけたら、書類の設定の「直す」から直せます。</p>
            {publishError && <div role="alert" className="of-err">{publishError}</div>}
            <div className="of-modal-btns">
              <button type="button" className="btn" disabled={publishing === 'busy'} onClick={() => setPublishing(null)}>戻る</button>
              <button type="button" className="btn btn-p" disabled={publishing === 'busy'} onClick={() => void publish()}>{publishing === 'busy' ? '確かめています…' : '使い始める'}</button>
            </div>
          </section>
        </>
      )}
    </OfficeShell>
  )
}

/** 欄に入るものの言い方。印の欄は「〇〇のときに印を付けます」 */
function sentence(m: ManagedVersion['slots'][string] | undefined, mode: 'guess' | 'confirm' | 'is') {
  const what = <strong>{m?.what ?? '（まだ決まっていません）'}</strong>
  const tail = mode === 'guess' ? '合っていますか？' : mode === 'confirm' ? 'これで合っていますか？' : ''
  if (m?.mark) {
    const verb = mode === 'guess' ? 'に印を付けると思います。' : 'に印を付けます。'
    return <>この欄には、{what}のとき{verb}{tail}</>
  }
  const verb = m?.rec
    ? (mode === 'guess' ? 'を書くと思います。録音で話に出たら、AI が書きます。' : 'を書きます。録音で話に出たら、AI が書きます。')
    : (mode === 'guess' ? 'が入ると思います。' : 'が入ります。')
  return <>ここには、{what}{verb}{tail}</>
}

function pageOfSlot(v: ManagedVersion, name: string): number | null {
  for (const p of v.formVersion.pages) if ((v.formVersion.schemas[p.pdfIndex] ?? []).some((s) => s.name === name)) return p.no
  return null
}
