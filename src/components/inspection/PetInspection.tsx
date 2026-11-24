// ペットの「点検する」（AI 点検の結果とこれまでの点検）。決定版: https://claude.ai/artifact/La1RqwX2TgoBN8eyRtfyPi
// 点検は裏で動く（worker）。待つあいだも用紙を直せ、メニューに戻っても止まらない。点検は用紙を書き換えない。
import { useCallback, useEffect, useRef, useState, type ReactNode, type SVGProps } from 'react'
import { api } from '../../lib/api.ts'
import { PetMessage } from '../pet/PetVisuals.tsx'
import { catMessage, fmtWhen, historyRows, itemNote, monthGroups, radar, running, type HistoryRow, type InspectionSummary, type InspectionView } from './petInspection.ts'
import './PetInspection.css'

/** 開いている書類に応じた点検範囲。 */
type Scope=Awaited<ReturnType<typeof api.inspectionScope>>
const POLL_MS = 2500

/** 利用者の点検の一覧。いちばん新しい点検が動いているあいだは読み直す（メニューの小さい字にも使う） */
export function useInspections(clientId: string | undefined,documentId?:string) {
  const scopeKey=`${clientId??''}:${documentId??''}`
  const latestScope=useRef(scopeKey);latestScope.current=scopeKey
  const [loaded,setLoaded]=useState<{key:string;list:InspectionSummary[]}>()
  const list=loaded?.key===scopeKey?loaded.list:undefined
  const reload = useCallback(async () => {
    if (!clientId) return
    try {
      const result=await api.inspections(clientId,documentId)
      if(latestScope.current===scopeKey)setLoaded({key:scopeKey,list:result.inspections})
    } catch {
      // 読めなければ、前の一覧のまま
    }
  }, [clientId,documentId,scopeKey])
  useEffect(() => {
    setLoaded(undefined)
    void reload()
  }, [reload])
  const busy = !!list?.[0] && running(list[0])
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => { void reload() }, POLL_MS)
    return () => clearInterval(t)
  }, [busy, reload])
  return { list, reload }
}

const Ic = ({ paths, ...rest }: { paths: string[] } & Omit<SVGProps<SVGSVGElement>, 'd'>) => (
  <svg className="insp-ic" viewBox="0 0 24 24" aria-hidden="true" {...rest}>{paths.map((p) => <path key={p} d={p} />)}</svg>
)
const CHEVRON = ['M9 6l6 6-6 6']
const AGAIN = ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6']
const CLIP = ['M9 4h6v3H9z', 'M9 13l2 2 4-4']

function Radar({ view, skeleton = false,categories=[] }: { view?: InspectionView, skeleton?: boolean,categories?:string[] }) {
  const cats = view?.categories.length ? view.categories : categories.map(category=>({category,satisfied:0,total:1}))
  if(!cats.length)return null
  if(cats.length<3)return <div className="insp-categories" aria-hidden={skeleton||undefined}>{cats.map(c=><div key={c.category}><span>{c.category}</span><b>{skeleton?'…':`${c.satisfied} / ${c.total}`}</b><progress max={c.total} value={skeleton?0:c.satisfied} aria-label={c.category}/></div>)}</div>
  const r = radar(cats)
  const pts = (ps: { x: number, y: number }[]) => ps.map((p) => `${p.x},${p.y}`).join(' ')
  return (
    <svg className="insp-radar" viewBox="0 0 340 262" role={skeleton ? undefined : 'img'} aria-label={skeleton ? undefined : r.label} aria-hidden={skeleton || undefined}>
      {r.rings.map((ring, i) => <polygon key={i} className="grid" points={pts(ring)} />)}
      {r.axes.map((a, i) => <line key={i} className="axis" x1={r.center.x} y1={r.center.y} x2={a.x} y2={a.y} />)}
      {!skeleton && <polygon className="area" points={pts(r.points)} />}
      {!skeleton && r.points.map((p, i) => <circle key={i} className={p.ng ? 'pt-ng' : 'pt'} cx={p.x} cy={p.y} r="5" />)}
      {!skeleton && r.labels.map((l, i) => (
        <g key={i}>
          {l.lines.map((line, j) => <text key={j} x={l.x} y={l.y + j * 14} textAnchor={l.anchor}>{line}</text>)}
          <text className={l.ng ? 'v-ng' : 'v'} x={l.x} y={l.y + l.lines.length * 14 + 1} textAnchor={l.anchor}>{l.value}</text>
        </g>
      ))}
    </svg>
  )
}

function Pill({ verdict, icon = false }: { verdict: '要確認' | '適合', icon?: boolean }) {
  const ng = verdict === '要確認'
  return (
    <span className={`insp-pill ${ng ? 'insp-pill-ng' : 'insp-pill-ok'}`}>
      {icon && <Ic paths={ng ? ['M12 6v7M12 17.5v.5'] : ['M5 12l5 5 9-10']} />}{verdict}
    </span>
  )
}

function Result({ view, onAgain, onJump }: { view: InspectionView, onAgain?: () => void, onJump: (key: string,documentId?:string) => void }) {
  const ok = view.total - view.missingCount
  const verdict = view.verdict
  return (
    <div className="insp-sum">
      <div className="insp-top">
        <>{verdict?<Pill verdict={verdict} icon />:<span className="insp-pill insp-pill-none">判定保留</span>}</>
        {onAgain
          ? <button type="button" className="insp-mini-btn" onClick={onAgain}><Ic paths={AGAIN} />もう一度点検する</button>
          : <small>{fmtWhen(view.createdAt)} に点検{view.createdBy ? `・${view.createdBy}` : ''}</small>}
      </div>
      {onAgain && <p className="insp-date">{fmtWhen(view.createdAt)} に点検{view.createdBy ? `・${view.createdBy}` : ''}</p>}
      <div className="insp-bar" role="img" aria-label={`満たしている ${ok}、足りない ${view.missingCount}、判定できなかった ${view.coverage.unjudged}`}>
        {ok > 0 && <i className="insp-seg-ok" style={{ flex: ok }} />}
        {view.missingCount > 0 && <i className="insp-seg-ng" style={{ flex: view.missingCount }} />}
        {view.coverage.unjudged>0&&<i className="insp-seg-na" style={{flex:view.coverage.unjudged}}/>}
      </div>
      <div className="insp-legend">
        <span><span className="insp-mk insp-mk-ok">✓</span>満たしている {ok}</span>
        {view.missingCount > 0 && <span><span className="insp-mk insp-mk-ng">！</span>足りない {view.missingCount}</span>}
      </div>

      <div className="insp-sec">観点ごと<small>満たしている項目の数 / 項目の数</small></div>
      <p className="insp-scope-count">対象 {view.coverage.applicable}項目 ／ 判定済み {view.total}項目{view.coverage.unjudged>0&&` ／ 判定できなかった ${view.coverage.unjudged}項目`}</p>
      <Radar view={view} />
      <p className="insp-cnote">分類と項目数は、今回判定した項目に合わせて表示しています。</p>

      <div className="insp-sec">{view.items.length} 項目の結果<small>厚労省の点検項目の順</small></div>
      <div className="insp-items">
        {view.items.map((i) => {
          const note = itemNote(i)
          if (note === null) return <div key={i.id} className="insp-ck"><span className="n">{i.id}</span><span className="insp-mk insp-mk-ok">✓</span><span>{i.name}</span></div>
          const mk = i.level === null ? <span className="insp-mk insp-mk-na">？</span> : <span className="insp-mk insp-mk-ng">！</span>
          const content = <><span className="n">{i.id}</span>{mk}<span><b>{i.name}</b><small>{note}</small></span></>
          return i.fieldKey
            ? <button key={i.id} type="button" className="insp-ck insp-ck-ng" onClick={() => onJump(i.fieldKey!,i.documentId??undefined)}>{content}<Ic paths={CHEVRON} /></button>
            : <div key={i.id} className="insp-ck insp-ck-ng">{content}</div>
        })}
      </div>
      {!!view.references?.length&&<p className="insp-cnote">参考にした書類：{view.references.map(d=>`${docNames[d.kind]??d.kind}（保存版${d.rev}${d.unsaved?'・未保存の値を含む':''}）`).join('、')}。これらの項目は今回の点検数に含めません。</p>}
      <Uninspected coverage={view.coverage}/><p className="insp-vnote">足りない項目を押すと、点検した書類の該当欄に移ります。点検は用紙を書き換えません。</p>
    </div>
  )
}

const docNames:Record<string,string>={assessment:'アセスメント',care_plan_1:'第1表',care_plan_2:'第2表',care_plan_3:'第3表',care_plan_4:'第4表 会議記録',care_plan_5:'第5表 支援経過',monitoring:'モニタリング'}
function Uninspected({coverage}:{coverage:InspectionView['coverage']}) {
 return <details open className="insp-uninspected"><summary>今回点検していない {coverage.uninspected}項目</summary>{coverage.groups.map((g,i)=><div key={i}><span>{g.kinds.length?g.kinds.map(k=>docNames[k]??'書類').join('・'):'その他'}</span><small>{g.reason==='missing_document'?'書類なし':g.reason==='manual_only'?'書類だけでは判断不可':'今回の対象外'}・{g.count}</small></div>)}</details>
}

function Waiting({scope}:{scope:Scope}) {
  return (
    <div className="insp-sum insp-sum-wait">
      <div className="insp-top"><span className="insp-pill insp-pill-none">点検しています…</span><small>{scope.documentName}の{scope.coverage.applicable}項目</small></div>
      <div className="insp-steps" aria-live="polite">
        <div className="insp-srow"><span className="insp-sdot insp-s-done"><Ic paths={['M5 12l5 5 9-10']} /></span>書類を読む</div>
        <div className="insp-srow"><span className="insp-sdot insp-s-now" aria-hidden="true" />{scope.coverage.applicable}項目を評価する</div>
        <div className="insp-srow insp-srow-wait"><span className="insp-sdot insp-s-wait" aria-hidden="true" />足りない情報をまとめる</div>
        <div className="insp-ibar" aria-hidden="true"><span /></div>
      </div>
      <div className="insp-skel" aria-hidden="true"><Radar skeleton categories={scope.categories} /></div>
    </div>
  )
}

function Empty({ onStart, busy,scope }: { onStart: () => void, busy: boolean,scope:Scope }) {
  return (
    <div className="insp-sum insp-sum-wait">
      <div className="insp-top"><span className="insp-pill insp-pill-none">{scope.coverage.applicable?'まだ点検していません':'この書類は点検対象外です'}</span><small>{scope.documentName}の{scope.coverage.applicable}項目</small></div>
      <div className="insp-over">
        <p>国のケアプラン点検項目で、今開いている書類を確かめます。用紙は書き換えません。</p>
        <button type="button" className="insp-prim" onClick={onStart} disabled={busy}>
          <svg className="insp-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2" />{CLIP.map((p) => <path key={p} d={p} />)}</svg>点検を始める
        </button>
      </div>
      <div className="insp-skel" aria-hidden="true">
        <div className="insp-bar"><i style={{ flex: 1, background: '#ddd5ee' }} /></div>
        <Radar skeleton categories={scope.categories} />
        <div style={{ display: 'grid', gap: 8 }}><div className="insp-sk" /><div className="insp-sk" style={{ width: '80%' }} /><div className="insp-sk" style={{ width: '90%' }} /></div>
      </div>
    </div>
  )
}

function HistRow({ row, onOpen }: { row: HistoryRow, onOpen: (id: string) => void }) {
  return (
    <button type="button" className={`insp-hist${row.current ? ' insp-hist-on' : ''}`} aria-current={row.current || undefined} onClick={() => onOpen(row.id)}>
      <span className="hd"><strong>{row.when}{row.current && <span className="insp-now">いま表示</span>}</strong>{row.by && <small>{row.by}</small>}</span>
      <span className="hn"><span className={`insp-mini ${row.tone==='none'?'insp-mini-none':row.tone === 'ok' ? 'insp-mini-ok' : 'insp-mini-ng'}`}>{row.label}</span>{row.diff && <small>{row.diff}</small>}</span>
      <Ic paths={CHEVRON} />
    </button>
  )
}

interface Props {
  clientId: string
  documentId?:string
  beforeStart?:()=>Promise<boolean>
  list: InspectionSummary[] | undefined
  reload: () => Promise<void>
  onJump: (key: string,documentId?:string) => void
}

export function PetInspection({ clientId,documentId,beforeStart, list, reload, onJump }: Props) {
  /** 見ている点検（null はいちばん新しい終わった点検） */
  const [scope,setScope]=useState<Scope>()
  useEffect(()=>{let live=true;setScope(undefined);setShownId(null);api.inspectionScope(clientId,documentId).then(r=>{if(live)setScope(r)}).catch(()=>{if(live)setError('点検する書類を取得できませんでした。')});return()=>{live=false}},[clientId,documentId])
  const [shownId, setShownId] = useState<string | null>(null)
  const [view, setView] = useState<InspectionView | null>(null)
  const [all, setAll] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  const head = list?.[0]
  const isRunning = !!head && running(head)
  const rows = list ? historyRows(list, null) : []
  const latestDone = rows[0]?.id ?? null
  const targetId = shownId ?? latestDone

  useEffect(() => {
    if (!targetId) { setView(null); return }
    let live = true
    api.inspection(targetId).then((r) => { if (live) setView(r.inspection) }).catch(() => { if (live) setError('点検の結果を読めませんでした。') })
    return () => { live = false }
  }, [targetId, list])

  const start = async () => {
    setStarting(true)
    setError('')
    setShownId(null)
    try {
      if(beforeStart&&!await beforeStart()){setError('入力を送信できませんでした。用紙を確認してから点検してください。');return}
      await api.startInspection(clientId,documentId)
      await reload()
    } catch {
      setError('点検を始められませんでした。少し待ってから、もう一度お試しください。')
    } finally {
      setStarting(false)
    }
  }

  if (!list||!scope) return <p className="assistant-empty" role={error?'alert':undefined}>{error||'読み込んでいます…'}</p>

  const viewingOld = !!view && shownId !== null && shownId !== latestDone
  const current = view && view.id === targetId ? view : null
  const failedLast = head?.status === 'failed' && !rows.length
  const hist = historyRows(list, current?.id ?? null)

  let message: ReactNode
  if (isRunning) message = <>点検しています。1〜2 分かかります。そのあいだも、用紙を直せます。</>
  else if (current) {
    // いちばん新しい終わった点検を見ているときは「結果は…です」。用紙が変わったかは、API が最新の点検にだけ返す
    const m = catMessage({ ...current, latest: !viewingOld })
    message = <>{m.before}{m.pill && <Pill verdict={m.pill} />}{m.after}</>
  } else if (failedLast) message = <>点検が終わりませんでした。もう一度、始めてください。</>
  else if (!rows.length) message = <>まだ点検していません。始めると、1〜2 分でここに結果が出ます。</>
  else message = <>読み込んでいます…</>

  return (
    <div className="insp">
      <div className="insp-document-scope"><small>今回の対象</small><strong>{scope.documentName}</strong><span>今開いている書類を点検します。</span></div>
      {viewingOld && current && (
        <div className="insp-band">
          <svg className="insp-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          <strong>{fmtWhen(current.createdAt)} の点検を見ています</strong>
          <span>そのときの書類で点検した結果です。</span>
          <button type="button" onClick={() => setShownId(null)}>最新の結果に戻る</button>
        </div>
      )}
      <PetMessage>{message}</PetMessage>

      {isRunning && !viewingOld ? <Waiting scope={scope} />
        : current ? <Result view={current} onAgain={viewingOld || isRunning ? undefined : start} onJump={onJump} />
          : !rows.length ? <Empty scope={scope} onStart={start} busy={starting||scope.coverage.applicable===0} /> : null}

      {(hist.length > 0 || isRunning) && (
        <>
          <div className="insp-sect">これまでの点検<small>{all ? `全 ${hist.length} 件` : '押すと上の結果が替わる'}</small></div>
          {isRunning && <div className="insp-hist-run"><span className="insp-sdot insp-s-now" aria-hidden="true" />いま点検しています</div>}
          {all
            ? monthGroups(hist).map((g) => (
              <div key={g.month} className="insp-list">
                <p className="insp-mon">{g.month}</p>
                {g.rows.map((row) => <HistRow key={row.id} row={{ ...row, diff: null }} onOpen={setShownId} />)}
              </div>
            ))
            : <ul className="insp-list">{hist.slice(0, 3).map((row) => <li key={row.id}><HistRow row={row} onOpen={setShownId} /></li>)}</ul>}
          {hist.length > 3 && (
            <button type="button" className="insp-more" onClick={() => setAll(!all)}>
              {all ? <>閉じる<Ic paths={['M6 15l6-6 6 6']} /></> : <>前の点検をすべて見る（ほかに {hist.length - 3} 件）<Ic paths={['M6 9l6 6 6-6']} /></>}
            </button>
          )}
        </>
      )}
      {error && <p className="assistant-error" role="alert">{error}</p>}
    </div>
  )
}
