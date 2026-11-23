import { useEffect, useRef, useState } from 'react'
import type { CareRecordConfirmation, CareRecordKind } from '../../../core/care-record.ts'
import { api } from '../../lib/api.ts'

export function CareRecordConfirmationPanel({documentId,clientId,kind,revision,dirty,readOnly,busy,onWorkingChange}:{
  documentId:string;clientId:string;kind:CareRecordKind;revision:number;dirty:boolean;readOnly:boolean;busy:boolean;onWorkingChange:(value:boolean)=>void
}) {
  const [loaded,setLoaded]=useState<{revision:number;confirmation:CareRecordConfirmation|null}>()
  const [plans,setPlans]=useState<{id:string;version:number;effectiveFrom:string}[]>([])
  const [planId,setPlanId]=useState(''),[error,setError]=useState('')
  const acting=useRef(false)
  useEffect(()=>{
    let active=true
    setError('')
    if(!revision){setLoaded({revision,confirmation:null});setPlanId('');return}
    void Promise.all([api.careRecordRevision(documentId,revision),kind==='care_plan_4'?api.carePlans(clientId):Promise.resolve({plans:[]})]).then(([r,p])=>{
      if(!active)return
      setLoaded({revision,confirmation:r.revision.confirmation});setPlanId(r.revision.confirmation?.planId??'')
      setPlans(p.plans.filter(v=>v.status==='confirmed'||v.status==='superseded'))
    },e=>{if(active)setError(e instanceof Error?e.message:'確定状態を取得できませんでした')})
    return()=>{active=false}
  },[documentId,clientId,kind,revision])
  const ready=loaded?.revision===revision,confirmation=ready?loaded.confirmation:null
  const confirm=async()=>{
    if(acting.current||busy||dirty||readOnly||!ready||!revision||confirmation)return
    if(!window.confirm(`保存版 ${revision} の内容を確認し、確定しますか？`))return
    acting.current=true;onWorkingChange(true);setError('')
    try{const r=await api.confirmCareRecord(documentId,revision,planId||null);setLoaded({revision,confirmation:r.confirmation})}
    catch(e){setError(e instanceof Error?e.message:'確定できませんでした。保存版と入力を確認してください')}
    finally{acting.current=false;onWorkingChange(false)}
  }
  return <section aria-label="記録の確定" className="care-record-confirmation">
    <p role="status">{!ready?'確定状態を取得中…':dirty?'編集中（現在の入力は未確定）':confirmation?`保存版 ${revision} は確定済み`:'この保存版は未確定です'}</p>
    {confirmation&&<p>保存版 {revision} の確定日時：{new Date(confirmation.confirmedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}{confirmation.planVersion!=null&&` ／ 関連計画版 ${confirmation.planVersion}`}</p>}
    {kind==='care_plan_4'&&!readOnly&&!confirmation&&<label>関連する確定済み計画版（任意）<select aria-label="関連する確定済み計画版" value={planId} disabled={busy||!ready} onChange={e=>setPlanId(e.target.value)}><option value="">関連付けなし</option>{plans.map(p=><option key={p.id} value={p.id}>計画版 {p.version} ・ {p.effectiveFrom}</option>)}</select></label>}
    {!readOnly&&<button type="button" className="btn" disabled={busy||dirty||!ready||!revision||!!confirmation} onClick={()=>void confirm()}>この保存版を確定</button>}
    {error&&<p role="alert" className="care-record-error">{error}</p>}
  </section>
}
