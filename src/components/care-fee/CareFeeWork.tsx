import { OfficialCareWorkspace } from '../care-paper/OfficialCareWorkspace.tsx'
import { useEffect,useRef,useState } from 'react'
import { FEE_MASTER,type FeeInput } from '../../../core/care-fees.ts'
import type { CareFeeCalculation,CareFeeSummary } from '../../../core/care-fee-api.ts'
import type { CareMonthSummary,CareMonthSaved } from '../../../core/care-month-api.ts'
import { api } from '../../lib/api.ts'
import { downloadBlob } from '../../lib/download.ts'
import { CareFeeConditions } from './CareFeeConditions.tsx'
import { CareFeeResult } from './CareFeeResult.tsx'
import '../care-record/CareRecordWork.css'
import './CareFeeWork.css'
const empty=():FeeInput=>({masterId:FEE_MASTER.id,basis:'planned',region:null,careLevel:null,copay:null,scopeConfirmed:false,codes:{},standardMinutes:{}})
export function CareFeeWork({clientId,clientName,onBack,onDirtyChange,onBusyChange}:{clientId:string;clientName:string;onBack:()=>void;onDirtyChange?:(v:boolean)=>void;onBusyChange?:(v:boolean)=>void}) {
 const [months,setMonths]=useState<CareMonthSummary[]>([]),[fees,setFees]=useState<CareFeeSummary[]>([]),[source,setSource]=useState<CareMonthSaved>(),[revisions,setRevisions]=useState<{rev:number;savedAt:string}[]>([])
 const [calculation,setCalculation]=useState<CareFeeCalculation>(),[history,setHistory]=useState<{id:string;revision:number;createdAt:string}[]>([]),[input,setInput]=useState<FeeInput>(empty),[dirty,setDirty]=useState(false)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 useEffect(()=>{onDirtyChange?.(!!dirty)},[dirty,onDirtyChange])
 useEffect(()=>{onBusyChange?.(busy)},[busy,onBusyChange])
 const active=useRef(true),acting=useRef(false),request=useRef<{id:string;fingerprint:string}|undefined>(undefined)
 const refresh=async()=>{const [m,f]=await Promise.all([api.careMonths(clientId),api.careFees(clientId)]);if(active.current){setMonths(m.months.filter(v=>v.revision>0));setFees(f.fees)}}
 useEffect(()=>{active.current=true;void refresh().catch(e=>{if(active.current)setError(e instanceof Error?e.message:'一覧を取得できませんでした')});return()=>{active.current=false}},[clientId])
 useEffect(()=>{if(!dirty)return;const leave=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave)},[dirty])
 const run=async(fn:()=>Promise<void>)=>{if(acting.current)return;acting.current=true;setBusy(true);setError('');setNotice('');try{await fn()}catch(e){if(active.current)setError(e instanceof Error?e.message:'処理に失敗しました。入力条件は保持しています。')}finally{acting.current=false;if(active.current)setBusy(false)}}
 const mayDiscard=()=>!dirty||window.confirm('保存していない算定条件を破棄して移動しますか？')
 const change=(patch:Partial<FeeInput>)=>{setInput(old=>({...old,...patch,scopeConfirmed:'scopeConfirmed'in patch?patch.scopeConfirmed!:false}));setDirty(true)}
 const loadSource=async(monthId:string,revision?:number)=>{
  const current=await api.careMonth(monthId),rev=revision??current.month.revision
  const [s,h]=await Promise.all([api.careMonthRevision(monthId,rev),api.revisions(current.month.documentId)])
  if(!active.current)return
  setSource(s);setRevisions(h.revisions)
 }
 const chooseMonth=(id:string)=>void run(async()=>{if(!id||!mayDiscard())return;await loadSource(id);setCalculation(undefined);setHistory([]);setInput(empty());setDirty(false);request.current=undefined})
 const loadCalculation=async(feeId:string,calcId?:string)=>{
  const [r,h]=await Promise.all([api.careFee(feeId,calcId),api.careFeeHistory(feeId)])
  await loadSource(r.calculation.monthId,r.calculation.sourceRevision)
  if(!active.current)return
  setCalculation(r.calculation);setHistory(h.history);setInput(r.calculation.input);setDirty(false);request.current=undefined
 }
 const calculate=()=>void run(async()=>{
  if(!source)return
  const existing=fees.find(f=>f.monthId===source.month.id&&f.basis===input.basis)
  const baseRevision=existing?(calculation?.groupId===existing.id?calculation.revision:existing.revision):0
  const params={...input,sourceRevision:source.revision,baseRevision},fingerprint=JSON.stringify({monthId:source.month.id,params})
  if(request.current?.fingerprint!==fingerprint)request.current={id:crypto.randomUUID(),fingerprint}
  const r=await api.calculateCareFee(source.month.id,{...params,requestId:request.current.id})
  if(!active.current)return
  request.current=undefined;setCalculation(r.calculation);setInput(r.calculation.input);setDirty(false);setNotice('第7表の算定を保存しました')
  const h=await api.careFeeHistory(r.calculation.groupId);if(active.current)setHistory(h.history);await refresh()
 })
 const confirm=()=>void run(async()=>{
  if(!calculation||dirty||!window.confirm('保存版 '+calculation.revision+' の算定を確定しますか？ 再計算は新しい保存版になります。'))return
  const r=await api.confirmCareFee(calculation.groupId,calculation.id,calculation.revision)
  if(active.current){setCalculation(r.calculation);setNotice('この算定を確定しました')}
 })
 const editor = <>
   {error&&<p role="alert" className="care-record-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
   {!source?<p>保存済みの第6表と、その保存版を選択してください。</p>:<><h2>{source.month.month} ・ 計画版 {source.month.planVersion} ／ 第6表 保存版 {source.revision}</h2><p>マスター：{input.masterId}（検証範囲 {FEE_MASTER.effectiveFrom}〜{FEE_MASTER.verifiedThrough}）</p><CareFeeConditions value={input} source={source} disabled={busy} onChange={change} /><button className="savebtn" disabled={busy} onClick={calculate}>この条件で計算して保存</button>{dirty&&<p role="status">算定条件の変更はまだ保存していません。</p>}</>}
   {calculation&&<><label>算定履歴<select aria-label="算定履歴" value={calculation.id} disabled={busy} onChange={e=>{const id=e.target.value;void run(async()=>{if(mayDiscard())await loadCalculation(calculation.groupId,id)})}}>{history.map(h=><option key={h.id} value={h.id}>保存版 {h.revision}</option>)}</select></label><CareFeeResult calculation={calculation} /><div className="care-fee-actions"><button className="btn" disabled={busy} onClick={()=>void run(async()=>downloadBlob(await api.pdf(calculation.documentId,calculation.revision),'サービス利用票別表_'+calculation.month+'_'+clientName+'.pdf'))}>この算定のPDF</button><button className="btn" disabled={busy||dirty||!!calculation.confirmedAt||calculation.result.status!=='calculated'} onClick={confirm}>{calculation.confirmedAt?'確定済み':'この算定を確定'}</button></div></>}
 </>
 return <main className="care-record-work care-fee-work"><header className="care-record-header"><button className="btn" disabled={busy} onClick={()=>{if(mayDiscard())onBack()}}>ケアプランに戻る</button><h1>{clientName} さんのサービス利用票別表</h1></header>
  <div className="care-record-columns"><aside className="care-record-list" aria-label="第7表の参照月と保存済み算定"><h2>参照する第6表</h2><label>第6表（保存済み）<select aria-label="第6表（保存済み）" value={source?.month.id??''} disabled={busy} onChange={e=>chooseMonth(e.target.value)}><option value="">対象月・計画版を選択</option>{months.map(m=><option key={m.id} value={m.id}>{m.month} ・ 計画版 {m.planVersion}</option>)}</select></label>{!months.length&&<p>第6表を保存してから選択してください。</p>}
   {source&&<label>第6表の保存版<select aria-label="第6表の保存版" value={source.revision} disabled={busy} onChange={e=>{const rev=Number(e.target.value);void run(async()=>{setInput(v=>({...v,scopeConfirmed:false}));setDirty(true);await loadSource(source.month.id,rev)})}}>{revisions.map(r=><option key={r.rev} value={r.rev}>保存版 {r.rev}</option>)}</select></label>}
   <h2>保存済みの算定</h2>{!fees.length?<p>算定はまだありません。</p>:<ol>{fees.map(f=><li key={f.id}><button type="button" disabled={busy} aria-pressed={calculation?.groupId===f.id} onClick={()=>void run(async()=>{if(mayDiscard())await loadCalculation(f.id)})}>{f.month} ・ {f.basis==='planned'?'予定':'実績'}<small>保存版 {f.revision} ・ {f.status==='calculated'?'計算済み':'未計算'}</small></button></li>)}</ol>}
  </aside><section className="care-record-editor" aria-label="第7表の計算と保存結果">
   {calculation && source ? <OfficialCareWorkspace documentId={calculation.documentId} revision={calculation.revision} values={{}} title="第7表・サービス利用票別表" status={dirty ? '算定条件に未保存の変更があります' : '保存済みの算定結果'}>{editor}</OfficialCareWorkspace> : editor}
  </section></div>
 </main>
}
