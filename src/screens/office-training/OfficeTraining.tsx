// 責任者の画面（#115）: AI 特訓部屋。#154 で採用した試作（prototypes/154-ai-training-room の案 5）の並び・言葉・動きのまま。
// 左に項目の一覧、右にチャット。項目ごとに AI が「ここには、録音からこれを書きます」と答え、責任者は［合格］かダメ出しを返す。
// 教えたことはその場で保存する（PUT /api/office/topics/:kind）。どの項目のことかは AI が決める（POST .../teach。保存はしない）。
// 数字は、見た項目（合格の印）と覚えたこと（書き足しの行と足した項目）の数だけを出す。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, type OfficeTopicsEdit, type TrainingItem, type TrainingView } from '../../lib/api.ts'
import { BackLink, OfficeShell } from '../../components/office-shell/OfficeShell.tsx'
import './training.css'

const CAT = '/assistant/pet-peeking.png'
const CATJ = '/assistant/pet-cat.jpg'
const ADDED = '事業所で足した項目'

type Quick = { label: string, run: () => void }
type Entry = { id: number, who: 'me', text: string } | { id: number, who: 'cat', node: ReactNode, slide?: boolean }
type Group = { name: string, ids: string[] }
type Bump = { n: number, plus: string | null, on: boolean }

/** 項目の並び: 区切り（基本情報・課題分析など）の順。区切りのない項目は「項目」にまとめる。特訓部屋で足した項目は別 */
function groupsOf(items: TrainingItem[]): Group[] {
  const out: Group[] = []
  for (const it of items) {
    if (it.origin === 'added') continue
    const name = it.section ?? '項目'
    const g = out.find((x) => x.name === name) ?? (out.push({ name, ids: [] }), out[out.length - 1])
    g.ids.push(it.id)
  }
  return out
}

/** 保存する形（全部を置き換える） */
const toEdit = (items: TrainingItem[]): OfficeTopicsEdit => ({
  // id が空の項目（足したばかり）は、保存のときに id が振られる
  added: items.filter((i) => i.origin === 'added').map(({ id, name, guide }) => (id ? { id, name, guide } : { name, guide })),
  notes: Object.fromEntries(items.filter((i) => i.notes.length).map((i) => [i.id, i.notes])),
  passed: items.filter((i) => i.passed).map((i) => i.id),
})

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String((e as Error).message))

/** 「ここには、録音からこれを書きます」の箱。fresh なら最後に足した行を光らせる */
function Box({ item, fresh }: { item: TrainingItem, fresh?: boolean }) {
  return (
    <div className="box"><b>ここには、録音からこれを書きます</b>{item.guide}
      {item.notes.map((r, k) => <span key={k} className={`addline${fresh && k === item.notes.length - 1 ? ' grow' : ''}`}>＋ {r}</span>)}
    </div>
  )
}

/** 「AI が成長しました」の札（取り消せる） */
function GrowCard({ title, children, onUndo }: { title: string, children: ReactNode, onUndo: () => Promise<boolean> }) {
  const [undone, setUndone] = useState(false)
  return (
    <div className={`growcard${undone ? ' undone' : ''}`}>
      <div className="gk">{title}</div>{children}
      {!undone && <button type="button" className="undo" onClick={() => { void onUndo().then((ok) => { if (ok) setUndone(true) }) }}>取り消す</button>}
    </div>
  )
}

function confetti(host: HTMLElement | null) {
  if (!host || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const cv = document.createElement('canvas')
  cv.className = 'tr-confetti'
  document.body.appendChild(cv)
  const W = (cv.width = innerWidth), H = (cv.height = innerHeight), x = cv.getContext('2d')
  if (!x) { cv.remove(); return }
  const cs = getComputedStyle(host)
  const cols = ['--brand', '--success', '--warning'].map((k) => cs.getPropertyValue(k).trim())
  const P = Array.from({ length: 140 }, (_, k) => ({ x: W / 2 + (Math.random() - 0.5) * 200, y: H * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 12 - 4, r: Math.random() * 6 + 3, c: cols[k % 3], a: Math.random() * 6 }))
  const t0 = performance.now()
  const f = (t: number) => {
    const e = t - t0
    x.clearRect(0, 0, W, H)
    for (const p of P) {
      p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.a += 0.2
      x.save(); x.translate(p.x, p.y); x.rotate(p.a); x.fillStyle = p.c; x.globalAlpha = Math.max(0, 1 - e / 1800); x.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); x.restore()
    }
    if (e < 1800) requestAnimationFrame(f); else cv.remove()
  }
  requestAnimationFrame(f)
}

export function OfficeTraining({ staffName, kind }: { staffName: string, kind: string }) {
  const [view, setView] = useState<TrainingView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [quick, setQuick] = useState<Quick[]>([])
  const [cur, setCur] = useState<string | null>(null)
  const [streak, setStreak] = useState(0)
  const [bump, setBump] = useState<Bump>({ n: 0, plus: null, on: false })
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const viewRef = useRef<TrainingView | null>(null)
  const curRef = useRef<string | null>(null)
  const shown = useRef(new Set<string>())
  const bonusAsked = useRef(false)
  const seq = useRef(0)
  const logRef = useRef<HTMLDivElement>(null)
  const roomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const items = view?.items ?? []
  const groups = groupsOf(items)
  const walk = groups.flatMap((g) => g.ids)
  const added = items.filter((i) => i.origin === 'added')
  const byId = (id: string) => viewRef.current?.items.find((i) => i.id === id)

  const put = (v: TrainingView) => { viewRef.current = v; setView(v) }
  const cat = (node: ReactNode, slide = false) => setEntries((e) => [...e, { id: ++seq.current, who: 'cat', node, slide }])
  const me = (t: string) => setEntries((e) => [...e, { id: ++seq.current, who: 'me', text: t }])
  const go = (bumpPlus: string | null) => setBump((b) => ({ n: b.n + 1, plus: bumpPlus, on: true }))
  const setCurrent = (id: string | null) => { curRef.current = id; setCur(id) }

  /** 直した一覧を保存する。保存できなければ、猫が伝えて読み直す */
  const save = async (next: TrainingItem[]): Promise<boolean> => {
    try {
      put(await api.saveOfficeTraining(kind, toEdit(next)))
      return true
    } catch (e) {
      cat(<>保存できませんでした（{errText(e)}）。もう一度お願いします。</>)
      api.officeTraining(kind).then(put).catch(() => {})
      return false
    }
  }
  const patch = (id: string, f: (i: TrainingItem) => TrainingItem) => (viewRef.current?.items ?? []).map((i) => (i.id === id ? f(i) : i))

  useEffect(() => {
    let live = true
    api.officeTraining(kind).then((v) => {
      if (!live) return
      put(v)
      // 開いたときにもう修了している区切りは、紙吹雪を出し直さない
      for (const g of groupsOf(v.items)) if (g.ids.every((id) => v.items.find((i) => i.id === id)?.passed)) shown.current.add(g.name)
      const any = v.items.length > 0
      if (!any) {
        cat(<><p className="hello">AI を特訓しましょう</p>書いてほしいことを教えてください。一言で、AI はその場で成長します。</>)
        return
      }
      cat(<>
        <p className="hello">AI を特訓しましょう</p>項目ごとに、AI が「ここには、これを書きます」と答えます。足りなければダメ出しを。一言で、AI はその場で成長します。
        <div className="ba"><div className="ba-col"><span className="ba-l">いまの AI</span><span className="ba-v old">水分は適度に飲んでいる</span></div><span className="ba-arrow" aria-hidden="true">→</span><div className="ba-col"><span className="ba-l">ダメ出しのあと</span><span className="ba-v new">1 日にコップ 4 杯ほど（夏は多め）</span></div></div>
        <p className="soft">気になる項目だけで大丈夫。途中でやめても、覚えたことは残ります。</p>
      </>)
      const ids = groupsOf(v.items).flatMap((g) => g.ids)
      const first = ids.find((id) => !v.items.find((i) => i.id === id)?.passed) ?? ids[0]
      const started = v.items.some((i) => i.passed)
      if (first) setQuick([{ label: started ? '続きからはじめる' : '特訓をはじめる', run: () => ask(first) }])
    }).catch((e) => { if (live) setLoadError(errText(e)) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, quick])

  const walkNow = () => groupsOf(viewRef.current?.items ?? []).flatMap((g) => g.ids)
  const nextOf = (id: string) => { const w = walkNow(); const i = w.indexOf(id); return i >= 0 ? w[i + 1] ?? null : null }

  function ask(id: string | null) {
    if (!id) { bonus(); return }
    const it = byId(id)
    if (!it) return
    setCurrent(id)
    setBump((b) => ({ ...b, plus: null, on: false }))
    const w = walkNow()
    const pos = w.indexOf(id)
    cat(<>
      <div className="sub">{pos >= 0 ? `${pos + 1} / ${w.length} ・ ${it.name}` : `${ADDED} ・ ${it.name}`}</div>
      <Box item={it} /><p style={{ marginTop: 8 }}>合格ですか？</p>
    </>, true)
    setQuick([
      { label: '合格', run: () => void pass() },
      { label: 'ここも書いてほしい', run: () => { cat('何が足りませんか？ 一言でどうぞ。'); inputRef.current?.focus() } },
      ...(it.removable ? [{ label: 'この項目はいらない', run: () => void remove(id) }] : []),
    ])
  }

  async function pass() {
    const id = curRef.current
    if (!id) return
    if (!(await save(patch(id, (i) => ({ ...i, passed: true }))))) return
    setStreak((s) => s + 1)
    go('+1')
    if (!sectionCheck(id)) setTimeout(() => ask(nextOf(id)), 280)
  }

  /** 区切りの項目が全部済んだら、紙吹雪と修了の札 */
  function sectionCheck(id: string): boolean {
    const v = viewRef.current
    if (!v) return false
    const gs = groupsOf(v.items)
    const gi = gs.findIndex((g) => g.ids.includes(id))
    const g = gs[gi]
    if (!g || shown.current.has(g.name)) return false
    if (!g.ids.every((x) => v.items.find((i) => i.id === x)?.passed)) return false
    shown.current.add(g.name)
    confetti(roomRef.current)
    const all = gs.every((x) => shown.current.has(x.name))
    const taught = (ids: string[]) => v.items.filter((i) => ids.includes(i.id)).reduce((n, i) => n + i.notes.length, 0)
    const nPassed = v.items.filter((i) => i.passed).length
    const nTaught = v.items.reduce((n, i) => n + i.notes.length, 0) + v.items.filter((i) => i.origin === 'added').length
    const rest = gs.filter((x) => !shown.current.has(x.name))
    cat(<>
      <img className="happy" alt="" src={CATJ} />
      {all ? (
        <div className="cert"><div className="cert-k">特訓 修了</div><div className="cert-t">{v.kind.name}の特訓が終わりました</div>
          <div className="cert-s"><span>合格 <b>{nPassed}</b></span><span>覚えたこと <b>{nTaught}</b></span></div><p>次の録音から、この事業所のやり方で書きます。</p></div>
      ) : (
        <div className="cert"><div className="cert-k">{g.name} 修了</div><div className="cert-t">{g.name}の {g.ids.length} 項目、終わりました</div>
          <div className="cert-s"><span>覚えたこと <b>{taught(g.ids)}</b></span></div><p>残りは{rest.map((x) => `${x.name}の ${x.ids.length} 項目`).join('、')}です。</p></div>
      )}
    </>)
    if (all) { setQuick([]); setTimeout(bonus, 600) } else {
      const next = nextOf(id) ?? rest[0]?.ids[0] ?? null
      setQuick([
        { label: '続ける', run: () => ask(next) },
        { label: '今日はここまで', run: () => cat('おつかれさまでした。ここまでの分は、もう効いています。続きはいつでもどうぞ。') },
      ])
    }
    return true
  }

  /** 標準の項目を見終わったあとの 1 問 */
  function bonus() {
    setCurrent(null)
    if (bonusAsked.current) { setQuick([]); return }
    bonusAsked.current = true
    cat('この中にない話で、書いてほしいことはありますか？ あれば一言でどうぞ。')
    setQuick([{ label: '特にない', run: () => cat('ありがとうございました。覚えたことは、左の一覧でいつでも見直せます。') }])
  }

  const afterTeach = () => {
    const c = curRef.current
    setQuick(c ? [
      { label: 'これで合格、次へ', run: () => { go('+1'); if (!sectionCheck(c)) ask(nextOf(c)) } },
      { label: 'もっとダメ出しする', run: () => { cat('どうぞ。'); inputRef.current?.focus() } },
    ] : walkNow().length ? [{ label: '特訓をはじめる', run: () => ask(walkNow().find((id) => !byId(id)?.passed) ?? walkNow()[0]) }] : [])
  }

  /** ダメ出しを項目に 1 行足す（見た項目にもなる） */
  async function grow(id: string, line: string) {
    if (!(await save(patch(id, (i) => ({ ...i, notes: [...i.notes, line], passed: true }))))) return
    const it = byId(id)!
    setStreak((s) => s + 1)
    const undo = async () => save(patch(id, (i) => ({ ...i, notes: i.notes.filter((r) => r !== line) })))
    cat(<>{id !== curRef.current && <>「{it.name}」のことですね。</>}わかりました。次の録音から、こう書きます。
      <GrowCard title="AI が成長しました" onUndo={undo}><Box item={it} fresh /></GrowCard></>)
    go('覚えた！')
    afterTeach()
  }

  async function addItem(name: string, guide: string) {
    const items = viewRef.current?.items ?? []
    const before = new Set(items.map((i) => i.id))
    const next: TrainingItem[] = [...items, { id: '', name, guide, notes: [], origin: 'added', removable: true, passed: false, section: null }]
    try { put(await api.saveOfficeTraining(kind, toEdit(next))) } catch (e) { cat(<>保存できませんでした（{errText(e)}）。</>); return }
    const made = viewRef.current?.items.find((i) => !before.has(i.id))
    setStreak((s) => s + 1)
    const undo = async () => made ? save((viewRef.current?.items ?? []).filter((i) => i.id !== made.id)) : false
    cat(<>どの項目にも入っていないので、新しい項目を足しました。
      <GrowCard title="新しい項目" onUndo={undo}><div className="box"><b>{name}</b>{guide}</div></GrowCard>
      録音で、この話が出たら書きます。</>)
    go('新しい項目！')
    afterTeach()
  }

  /** この項目はいらない（事業所の項目だけ） */
  async function remove(id: string) {
    const v = viewRef.current
    const it = byId(id)
    if (!v || !it) return
    const rest = v.items.filter((i) => i.id !== id)
    try {
      if (it.origin === 'office') {
        // 事業所が足した書類の、AI が作った項目は、書類の種類の一覧から消す
        await api.setOfficeTopics(kind, rest.filter((i) => i.origin === 'office').map(({ id: i, name, guide }) => ({ id: i, name, guide })))
      }
      put(await api.saveOfficeTraining(kind, toEdit(rest)))
    } catch (e) { cat(<>消せませんでした（{errText(e)}）。</>); return }
    cat(<>「{it.name}」を消しました。次の録音から、この項目はまとめません。</>)
    const next = nextOf(id) ?? (() => { const w = walkNow(); return w.find((x) => !byId(x)?.passed) ?? null })()
    setCurrent(null)
    setQuick(next ? [{ label: '次の項目へ', run: () => ask(next) }] : [])
  }

  async function onText(t: string) {
    me(t)
    setQuick([])
    setBusy(true)
    try {
      const { decision: d } = await api.teachOfficeTopic(kind, t, curRef.current)
      if (d.type === 'refuse') { cat('話に出ていないことは書かない決まりなので、これは覚えられません。分からないところは空けておきます。'); afterTeach(); return }
      if (d.type === 'ask') {
        cat(d.question || 'どちらのことですか？')
        setQuick(d.options.map((o) => ({ label: o.label, run: () => void grow(o.topicId, o.line) })))
        return
      }
      if (d.type === 'new') { await addItem(d.name, d.guide); return }
      await grow(d.topicId, d.line)
    } catch (e) {
      cat(<>うまく受け取れませんでした（{errText(e)}）。もう一度お願いします。</>)
      afterTeach()
    } finally { setBusy(false) }
  }

  const back = <BackLink to={`/office/forms/${encodeURIComponent(kind)}`} label={view?.kind.name ?? '書類'} />
  if (!view) {
    return <OfficeShell staffName={staffName} active="forms">{back}{loadError ? <div role="alert" className="of-err">読み込めませんでした（{loadError}）</div> : <div role="status" className="of-muted">読み込んでいます</div>}</OfficeShell>
  }

  const nPassed = walk.filter((id) => items.find((i) => i.id === id)?.passed).length
  const pct = walk.length ? Math.round((nPassed / walk.length) * 100) : 0
  const nTaught = items.reduce((n, i) => n + i.notes.length, 0) + added.length
  const done = groups.filter((g) => g.ids.every((id) => items.find((i) => i.id === id)?.passed))
  const row = (it: TrainingItem) => {
    const t = it.notes.length > 0 || it.origin === 'added'
    return (
      <button key={it.id} type="button" className="ti" aria-current={it.id === cur ? 'true' : undefined} onClick={() => ask(it.id)}>
        <span className={`st ${t ? 'add' : it.passed ? 'ok' : ''}`}>{t ? '＋' : it.passed ? '✓' : ''}</span><span>{it.name}</span>
        {it.notes.map((r, k) => <span key={k} className="taught">＋ {r}</span>)}
      </button>
    )
  }

  return (
    <OfficeShell staffName={staffName} active="forms">
      <div className="tr-room" ref={roomRef}>
        {back}
        <div className="titlerow"><h1 className="h1">AI 特訓部屋</h1><div className="badges">{done.map((g) => <span key={g.name} className="badge">{g.name} 修了</span>)}</div></div>
        <div className="map">
          <nav className="tree" aria-label="項目">
            <h2>特訓の項目</h2>
            {groups.map((g) => {
              const d = g.ids.filter((id) => items.find((i) => i.id === id)?.passed).length
              const full = d === g.ids.length
              return (
                <div key={g.name}>
                  <div className="secrow"><span>{g.name}</span><span className={`secn${full ? ' full' : ''}`}>{full ? '修了' : `${d} / ${g.ids.length}`}</span></div>
                  {g.ids.map((id) => row(items.find((i) => i.id === id)!))}
                </div>
              )
            })}
            {added.length > 0 && <><div className="secrow"><span>{ADDED}</span></div>{added.map(row)}</>}
            <button type="button" className="ti tr-add" onClick={() => { setCurrent(null); cat('どんなことを書いてほしいですか？ 一言でどうぞ。新しい項目にするか、今の項目に足すかは、AI が決めます。'); setQuick([]); inputRef.current?.focus() }}>
              <span className="st">＋</span><span>項目を足す</span>
            </button>
          </nav>
          <div className="col5">
            <div className="lv">
              <img key={`c${bump.n}`} alt="" src={bump.on ? CATJ : CAT} className={`lvcat${bump.on ? ' jump' : ''}`} />
              <div className="lvmain">
                <div className="lvtop">
                  <span className="lvl">AI の特訓度</span>
                  <span key={`p${bump.n}`} className={`pct${bump.on ? ' pop' : ''}`}>{pct}<small>%</small></span>
                  {streak >= 3 && <span key={`s${streak}`} className="combo">{streak} 連続！</span>}
                  <span className="lvtaught">覚えたこと <b>{nTaught}</b></span>
                </div>
                <div className="segs" style={{ gridTemplateColumns: `repeat(${Math.max(walk.length, 1)}, minmax(0,1fr))` }}>
                  {walk.map((id) => { const it = items.find((i) => i.id === id)!; return <i key={id} className={`${it.notes.length ? 'tg' : it.passed ? 'ok' : ''}${id === cur ? ' cur' : ''}`} /> })}
                </div>
              </div>
              {bump.plus && <span key={`f${bump.n}`} className="plus5">{bump.plus}</span>}
            </div>
            <div className="chatbox flat">
              <div className="log" ref={logRef} aria-live="polite">
                {entries.map((e) => e.who === 'me'
                  ? <div key={e.id} className="me">{e.text}</div>
                  : <div key={e.id} className={`msg${e.slide ? ' slidein' : ''}`}><img alt="" src={CAT} /><div className="bub">{e.node}</div></div>)}
                {busy && <div className="msg"><img alt="" src={CAT} /><div className="bub tr-think" role="status">考えています…</div></div>}
                {quick.length > 0 && !busy && (
                  <div className="quick">
                    {quick.map((q) => <button key={q.label} type="button" className="qr" onClick={() => { me(q.label); setQuick([]); q.run() }}>{q.label}</button>)}
                  </div>
                )}
              </div>
              <form className="compose" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (!t || busy) return; setText(''); void onText(t) }}>
                <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="ダメ出しを一言で（例: 水分の量は数字で）" aria-label="AI に伝えること" />
                <button className="b primary" type="submit" disabled={busy}>送る</button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </OfficeShell>
  )
}
