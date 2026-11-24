import {TouchInspection} from '../inspection/TouchInspection.tsx'
import type {InspectionContext} from '../inspection/context.ts'
import { useEffect, useId, useMemo, useRef, useState, type ComponentProps } from 'react'
import { CarePaperFlow } from '../care-paper/CarePaperFlow.ts'
import { CarePlanWork } from './CarePlanWork.tsx'
import { CareRecordWork } from '../care-record/CareRecordWork.tsx'
import { CareMonthWork } from '../care-month/CareMonthWork.tsx'
import { CareFeeWork } from '../care-fee/CareFeeWork.tsx'
import './care-plan-area.css'
import type { CareFeeSourceSelection } from '../../../core/care-fee-api.ts'

export const isCarePlanRelatedKind = (key: string) => /^care_plan_[1-7]$/.test(key)
const sections = [
  ['plans', '第1〜3表'], ['care_plan_4', '第4表 会議記録'], ['care_plan_5', '第5表 支援経過'],
  ['care_plan_6', '第6表 サービス利用票'], ['care_plan_7', '第7表 利用票別表'],
] as const
type Section = typeof sections[number][0]
const initialStatus = Object.fromEntries(sections.map(([key]) => [key, { dirty: false, busy: false }])) as Record<Section, { dirty: boolean, busy: boolean }>

/** 書類ごとの入力と選択位置を保持し、ケアプラン内だけで第1〜7表を切り替える。 */
export function CarePlanArea({ availableKinds, onDirtyChange, onBusyChange, outputTarget, historyRequest,onInspectionContextChange, ...props }: ComponentProps<typeof CarePlanWork> & { availableKinds: string[] }) {
  const [active, setActive] = useState<Section>('plans')
  const [inspectionContexts,setInspectionContexts]=useState<Partial<Record<Section,InspectionContext>>>()
  useEffect(()=>{onInspectionContextChange?.(inspectionContexts?.[active])},[onInspectionContextChange,active,inspectionContexts])
  const [planTable,setPlanTable]=useState(0)
  const scroll=useRef<HTMLDivElement>(null)
  const anchor=useRef<{number:number;offset:number}|undefined>(undefined)
  const manual=useRef(false)
  const scrollIdle=useRef<ReturnType<typeof setTimeout>>(undefined)
  const [jump,setJump]=useState<{number:number;request:number}>()
  const [status, setStatus] = useState(initialStatus)
  const [feeSource, setFeeSource] = useState<CareFeeSourceSelection>()
  const id = useId()
  const callbacks = useMemo(() => Object.fromEntries(sections.map(([key]) => [key, {
    onInspectionContextChange:(context:InspectionContext|undefined)=>setInspectionContexts(old=>old?.[key]===context?old:{...old,[key]:context}),
    onDirtyChange: (dirty: boolean) => setStatus(old => old[key].dirty === dirty ? old : { ...old, [key]: { ...old[key], dirty } }),
    onBusyChange: (busy: boolean) => setStatus(old => old[key].busy === busy ? old : { ...old, [key]: { ...old[key], busy } }),
  }])) as Record<Section, { onInspectionContextChange:(context:InspectionContext|undefined)=>void,onDirtyChange: (v: boolean) => void, onBusyChange: (v: boolean) => void }>, [])
  const dirty = Object.values(status).some(s => s.dirty), busy = Object.values(status).some(s => s.busy)
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  useEffect(() => { if (historyRequest) {setActive('plans');setJump(old=>({number:1,request:(old?.request??0)+1}))} }, [historyRequest])
  const choose = (key: Section, table=0) => { if (!busy) { setActive(key);if(key==='plans')setPlanTable(table);setJump(old=>({number:key==='plans'?table+1:Number(key.slice(-1)),request:(old?.request??0)+1})) } }
  useEffect(()=>{
    if(!jump||!scroll.current)return
    const container=scroll.current
    const move=()=>{const target=container.querySelector<HTMLElement>(`[data-care-table="${jump.number}"]`);if(!target)return false;const offset=jump.number<=3?(container.querySelector('.sheet-toolbar')?.getBoundingClientRect().height??0)+(container.querySelector('.cp-work>.cp-header')?.getBoundingClientRect().height??0):0;manual.current=false;container.scrollTo({top:target.getBoundingClientRect().top-container.getBoundingClientRect().top+container.scrollTop-offset,behavior:'instant'});anchor.current={number:jump.number,offset:target.getBoundingClientRect().top-container.getBoundingClientRect().top};return true}
    if(move())return
    const observer=new MutationObserver(()=>{if(move())observer.disconnect()});observer.observe(container,{childList:true,subtree:true});return()=>observer.disconnect()
  },[jump])
  useEffect(()=>{
    const container=scroll.current,flow=container?.firstElementChild
    if(!container||!flow)return
    const observer=new ResizeObserver(()=>{
      const saved=anchor.current;if(!saved||manual.current)return
      const target=container.querySelector<HTMLElement>(`[data-care-table="${saved.number}"]`);if(!target)return
      const delta=target.getBoundingClientRect().top-container.getBoundingClientRect().top-saved.offset
      if(Math.abs(delta)>1)container.scrollTop+=delta
    })
    observer.observe(flow)
    return()=>{observer.disconnect();clearTimeout(scrollIdle.current)}
  },[])
  const userScroll=()=>{manual.current=true;clearTimeout(scrollIdle.current);scrollIdle.current=setTimeout(()=>{manual.current=false},250)}
  const trackScroll=()=>{
    const container=scroll.current;if(!container)return
    // Focus, browser search and programmatic navigation may scroll without wheel events.
    // Preserve position only for layout changes in ResizeObserver; never undo navigation here.
    const toolbar=container.querySelector('.sheet-toolbar')?.getBoundingClientRect()
    const header=container.querySelector('.cp-work>.cp-header')?.getBoundingClientRect().height??0
    const top=container.getBoundingClientRect().top+Math.max(80,toolbar&&toolbar.top<=container.getBoundingClientRect().top+header+1?header+toolbar.height+20:0)
    const papers=[...container.querySelectorAll<HTMLElement>('[data-care-table]')]
    const found=papers.filter(p=>p.getBoundingClientRect().top<=top).at(-1)??papers[0]
    if(!found)return
    const number=Number(found.dataset.careTable);setActive(number<=3?'plans':`care_plan_${number}` as Section);if(number<=3)setPlanTable(number-1)
    anchor.current={number,offset:found.getBoundingClientRect().top-container.getBoundingClientRect().top}
    if(manual.current)userScroll()
  }
  const shown = sections.filter(([key]) => key === 'plans' || availableKinds.includes(key))
  return <CarePaperFlow.Provider value={true}><div className={`cp-area cp-area-continuous${props.embedded ? ' cp-area-embedded' : ''}`}>
    <div className="cp-area-tabs" role="tablist" aria-label="ケアプランの書類" aria-orientation="vertical"><strong>ケアプラン用紙</strong>{props.touch&&<div className="cp-touch-inspection"><TouchInspection clientId={props.clientId} context={inspectionContexts?.[active]}/></div>}{[0,1,2].map(i=><button type="button" role="tab" id={`${id}-plans-${i}-tab`} key={i} aria-selected={active==='plans'&&planTable===i} disabled={busy} onClick={()=>choose('plans',i)}>{['第1表 基本情報と方針','第2表 ニーズとサービス','第3表 週間計画'][i]}</button>)}{shown.filter(([key])=>key!=='plans').map(([key, label]) =>
      <button type="button" role="tab" id={`${id}-${key}-tab`} aria-selected={active === key} key={key} disabled={busy} onClick={() => choose(key)}>{label}</button>)}</div>
    <div className="cp-area-scroll" ref={scroll} onScroll={trackScroll} onWheel={userScroll} onTouchMove={userScroll} onPointerDown={e=>{if(e.target===e.currentTarget)userScroll()}} onKeyDown={userScroll} role="region" aria-label="ケアプラン全用紙"><div className="cp-area-flow">
    {shown.map(([key]) => <div key={key} className="cp-area-panel" data-care-table={key==='plans'?undefined:key.slice(-1)} data-active={key===active} role="tabpanel" aria-labelledby={key==='plans'?`${id}-plans-${planTable}-tab`:`${id}-${key}-tab`}>
      {key === 'plans' ? <CarePlanWork {...props} continuous hideNavigation selectedTable={planTable} active={active === 'plans'} onBack={() => { if (!Object.entries(status).some(([key, s]) => key !== 'plans' && s.dirty) || window.confirm('ケアプラン内に保存していない入力があります。入力を破棄して書類に戻りますか？')) props.onBack() }} {...callbacks.plans} historyRequest={historyRequest} outputTarget={active === 'plans' ? outputTarget : null} />
        : key === 'care_plan_4' || key === 'care_plan_5' ? <CareRecordWork {...callbacks[key]} clientId={props.clientId} clientName={props.clientName} kind={key} onBack={() => choose('plans')} />
          : key === 'care_plan_6' ? <CareMonthWork visible={active === key} {...callbacks[key]} clientId={props.clientId} clientName={props.clientName} onBack={() => choose('plans')} onOpenFee={availableKinds.includes('care_plan_7') ? selection => { setFeeSource({...selection, requestId:crypto.randomUUID()}); choose('care_plan_7') } : undefined} />
            : <CareFeeWork visible={active === key} {...callbacks[key]} selectedSource={feeSource} clientId={props.clientId} clientName={props.clientName} onBack={() => choose('plans')} />}
    </div>)}</div></div>
  </div></CarePaperFlow.Provider>
}
