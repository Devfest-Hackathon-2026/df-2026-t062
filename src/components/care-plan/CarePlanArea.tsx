import { useEffect, useId, useMemo, useState, type ComponentProps } from 'react'
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
export function CarePlanArea({ availableKinds, onDirtyChange, onBusyChange, outputTarget, historyRequest, ...props }: ComponentProps<typeof CarePlanWork> & { availableKinds: string[] }) {
  const [active, setActive] = useState<Section>('plans')
  const [planTable,setPlanTable]=useState(0)
  const [visited, setVisited] = useState<Set<Section>>(() => new Set(['plans']))
  const [status, setStatus] = useState(initialStatus)
  const [feeSource, setFeeSource] = useState<CareFeeSourceSelection>()
  const id = useId()
  const callbacks = useMemo(() => Object.fromEntries(sections.map(([key]) => [key, {
    onDirtyChange: (dirty: boolean) => setStatus(old => old[key].dirty === dirty ? old : { ...old, [key]: { ...old[key], dirty } }),
    onBusyChange: (busy: boolean) => setStatus(old => old[key].busy === busy ? old : { ...old, [key]: { ...old[key], busy } }),
  }])) as Record<Section, { onDirtyChange: (v: boolean) => void, onBusyChange: (v: boolean) => void }>, [])
  const dirty = Object.values(status).some(s => s.dirty), busy = Object.values(status).some(s => s.busy)
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  useEffect(() => { if (historyRequest) setActive('plans') }, [historyRequest])
  const choose = (key: Section, table=0) => { if (!busy) { setVisited(old => old.has(key) ? old : new Set([...old, key])); setActive(key); if(key==='plans')setPlanTable(table) } }
  const shown = sections.filter(([key]) => key === 'plans' || availableKinds.includes(key))
  return <div className={`cp-area${props.embedded ? ' cp-area-embedded' : ''}`}>
    <div className="cp-area-tabs" role="tablist" aria-label="ケアプランの書類" aria-orientation="vertical"><strong>ケアプラン用紙</strong>{[0,1,2].map(i=><button type="button" role="tab" id={`${id}-plans-${i}-tab`} key={i} aria-selected={active==='plans'&&planTable===i} disabled={busy} onClick={()=>choose('plans',i)}>{['第1表 基本情報と方針','第2表 ニーズとサービス','第3表 週間計画'][i]}</button>)}{shown.filter(([key])=>key!=='plans').map(([key, label]) =>
      <button type="button" role="tab" id={`${id}-${key}-tab`} aria-selected={active === key} key={key} disabled={busy} onClick={() => choose(key)}>{label}</button>)}</div>
    {shown.filter(([key]) => visited.has(key)).map(([key]) => <div key={key} className="cp-area-panel" role="tabpanel" aria-labelledby={key==='plans'?`${id}-plans-${planTable}-tab`:`${id}-${key}-tab`} hidden={key !== active}>
      {key === 'plans' ? <CarePlanWork {...props} hideNavigation selectedTable={planTable} active={active === 'plans'} onBack={() => { if (!Object.entries(status).some(([key, s]) => key !== 'plans' && s.dirty) || window.confirm('ケアプラン内に保存していない入力があります。入力を破棄して書類に戻りますか？')) props.onBack() }} {...callbacks.plans} historyRequest={historyRequest} outputTarget={active === 'plans' ? outputTarget : null} />
        : key === 'care_plan_4' || key === 'care_plan_5' ? <CareRecordWork {...callbacks[key]} clientId={props.clientId} clientName={props.clientName} kind={key} onBack={() => choose('plans')} />
          : key === 'care_plan_6' ? <CareMonthWork visible={active === key} {...callbacks[key]} clientId={props.clientId} clientName={props.clientName} onBack={() => choose('plans')} onOpenFee={availableKinds.includes('care_plan_7') ? selection => { setFeeSource({...selection, requestId:crypto.randomUUID()}); choose('care_plan_7') } : undefined} />
            : <CareFeeWork visible={active === key} {...callbacks[key]} selectedSource={feeSource} clientId={props.clientId} clientName={props.clientName} onBack={() => choose('plans')} />}
    </div>)}
  </div>
}
