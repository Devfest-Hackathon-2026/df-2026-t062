import { useContext } from 'react'
import { CarePaperFlow } from '../care-paper/CarePaperFlow.ts'
import { PaperDialog } from '../care-paper/PaperDialog.tsx'
import { OfficialCareWorkspace } from '../care-paper/OfficialCareWorkspace.tsx'
import { careMonthPrint } from '../../../core/care-month-print.ts'
import { CareMonthHeaderFields } from './CareMonthHeaderFields.tsx'
import { MonthHeaders, type MonthHeaderValues } from '../../../core/care-month-api.ts'
import { useEffect,useRef,useState,type ReactNode } from 'react'
import type { CareMonthView,CareMonthSummary } from '../../../core/care-month-api.ts'
import { monthCounts,monthOverlaps,type MonthEntry } from '../../../core/care-month.ts'
import { sameValue } from '../../../core/apply-batch.ts'
import { api } from '../../lib/api.ts'
import { downloadBlob } from '../../lib/download.ts'
import type { CarePlanSummary } from '../../../db/care-plans.ts'
import { CareMonthEntry } from './CareMonthEntry.tsx'
import { CareMonthNotes } from './CareMonthNotes.tsx'
import '../care-record/CareRecordWork.css'
import './CareMonthWork.css'
import type { CareFeeSourceSelection } from '../../../core/care-fee-api.ts'
function PreviewDialog({title,children,onCancel}:{title:string;children:ReactNode;onCancel:()=>void}) {
 const ref=useRef<HTMLDialogElement>(null)
 useEffect(()=>{const d=ref.current!;d.showModal();return()=>d.close()},[])
 return <dialog ref={ref} aria-label={title} className="care-month-dialog" onCancel={e=>{e.preventDefault();onCancel()}}><h2>{title}</h2>{children}</dialog>
}
function monthBefore(month:string){const date=new Date(month+'-01T00:00:00Z');date.setUTCMonth(date.getUTCMonth()-1);return date.toISOString().slice(0,7)}
type Preview={type:'create';data:Awaited<ReturnType<typeof api.previewCareMonth>>;planId:string;month:string}|{type:'change';entries:MonthEntry[];added:number;removed:number;skipped:number}
export function CareMonthWork({clientId,clientName,onBack,onDirtyChange,onBusyChange,onOpenFee,visible=true}:{clientId:string;clientName:string;onBack:()=>void;onDirtyChange?:(v:boolean)=>void;onBusyChange?:(v:boolean)=>void;visible?:boolean;onOpenFee?:(source:Omit<CareFeeSourceSelection,'requestId'>)=>void}) {
 const continuous=useContext(CarePaperFlow)
 const [choosing,setChoosing]=useState(false)
 const [list,setList]=useState<CareMonthSummary[]>([]),[plans,setPlans]=useState<CarePlanSummary[]>([]),[planId,setPlanId]=useState('')
 const [target,setTarget]=useState(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit'}).format(new Date()))
 const [headers,setHeaders]=useState<MonthHeaderValues>(()=>MonthHeaders.parse({}))
 const [current,setCurrent]=useState<CareMonthView>(),[entries,setEntries]=useState<MonthEntry[]>([]),[past,setPast]=useState<CareMonthView>()
 const [revisions,setRevisions]=useState<{rev:number;savedAt:string}[]>([]),[preview,setPreview]=useState<Preview>(),[sourceId,setSourceId]=useState(''),[serviceId,setServiceId]=useState('')
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const active=useRef(true),acting=useRef(false),createRequest=useRef<string|undefined>(undefined),saveRequest=useRef<{id:string;fingerprint:string}|undefined>(undefined)
 const dirty=!!current&&(!sameValue(entries,current.entries)||!sameValue(headers,current.headers??MonthHeaders.parse({}))),view=past??current,shown=past?.entries??entries
 useEffect(()=>{onDirtyChange?.(!!dirty)},[dirty,onDirtyChange])
 useEffect(()=>{onBusyChange?.(busy)},[busy,onBusyChange])
 const confirmed=plans.filter(p=>p.status!=='draft'),counts=monthCounts(shown),overlaps=monthOverlaps(shown)
 const initialSelection=useRef(false)
 const refresh=async()=>{const [months,p]=await Promise.all([api.careMonths(clientId),api.carePlans(clientId)]);if(!active.current)return;setList(months.months);setPlans(p.plans);setPlanId(old=>old||p.plans.find(v=>v.status==='confirmed')?.id||p.plans.find(v=>v.status==='superseded')?.id||'');if(!initialSelection.current){initialSelection.current=true;if(months.months[0])await run(()=>load(months.months[0].id))}}
 useEffect(()=>{active.current=true;if(visible||!initialSelection.current)void refresh().catch(e=>{if(active.current)setError(e instanceof Error?e.message:'一覧を読み込めませんでした')});return()=>{active.current=false}},[clientId,visible])
 useEffect(()=>{if(!dirty)return;const leave=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave)},[dirty])
 const run=async(fn:()=>Promise<void>)=>{if(acting.current)return;acting.current=true;setBusy(true);setError('');setNotice('');try{await fn()}catch(e){if(active.current)setError(e instanceof Error?e.message:'処理できませんでした。入力は保持しています。')}finally{acting.current=false;if(active.current)setBusy(false)}}
 const history=async(docId:string)=>{const r=await api.revisions(docId);if(active.current)setRevisions(r.revisions)}
 const saveCurrent=async()=>{
  if(!current||past)return undefined
  const fingerprint=JSON.stringify({baseVersion:current.lockVersion,entries,headers})
  if(saveRequest.current?.fingerprint!==fingerprint)saveRequest.current={id:crypto.randomUUID(),fingerprint}
  const r=await api.saveCareMonth(current.id,{baseVersion:current.lockVersion,entries,...(current.headers||!sameValue(headers,MonthHeaders.parse({}))?{headers}:{}),requestId:saveRequest.current.id})
  if(!active.current)return undefined
  saveRequest.current=undefined;setCurrent(r.month);setEntries(r.month.entries);setHeaders(r.month.headers??MonthHeaders.parse({}));setNotice('第6表を保存しました');await Promise.all([refresh(),history(r.month.documentId)]);return r.month
 }
 const preserve=async()=>{
  if(!dirty)return current
  if(!window.confirm('入力を保存して移動しますか？ キャンセルするとこの月に留まります。'))return false
  return await saveCurrent()||false
 }
 const load=async(id:string)=>{const r=await api.careMonth(id);if(!active.current)return;setCurrent(r.month);setTarget(r.month.month);setPlanId(r.month.planId);setEntries(r.month.entries);setHeaders(r.month.headers??MonthHeaders.parse({}));setPast(undefined);setServiceId(r.month.services[0]?.id??'');await history(r.month.documentId)}
 const select=(id:string)=>void run(async()=>{if(await preserve()===false)return;await load(id);setChoosing(false)})
 const generate=()=>void run(async()=>{if(await preserve()===false)return;const data=await api.previewCareMonth(clientId,planId,target);setChoosing(false);setPreview({type:'create',data,planId,month:target})})
 const accept=()=>void run(async()=>{
  if(!preview)return
  if(preview.type==='change'){setEntries(preview.entries);setPast(undefined);setPreview(undefined);return}
  createRequest.current??=crypto.randomUUID()
  const r=await api.createCareMonth(clientId,{planId:preview.planId,month:preview.month,confirmationId:preview.data.confirmationId,sourceHash:preview.data.sourceHash,requestId:createRequest.current})
  createRequest.current=undefined;setPreview(undefined);await load(r.month.id);await refresh()
 })
 const propose=(action:'regenerate'|'copy')=>void run(async()=>{
  if(!current)return;const fresh=await preserve();if(!fresh)return
  const p=await api.previewMonthAction(current.id,action==='copy'?{action,baseVersion:fresh.lockVersion,sourceMonthId:sourceId}:{action,baseVersion:fresh.lockVersion})
  setPreview({type:'change',entries:p.entries,added:p.added.length,removed:p.removed.length,skipped:p.skipped.length})
 })
 const showRevision=(rev:string)=>void run(async()=>{if(!current||await preserve()===false)return;if(!rev){setPast(undefined);return}const r=await api.careMonthRevision(current.id,Number(rev));setPast(r.month)})
 const updateEntry=(updated:MonthEntry)=>setEntries(rows=>rows.map(row=>row.id===updated.id?updated:row))
 const shownHeaders=past?past.headers??MonthHeaders.parse({}):headers
 const saveButton=<button className="savebtn" disabled={busy||!!past} onClick={()=>void run(async()=>{await saveCurrent()})}>第6表を保存</button>
 const add=()=>{if(!current)return;const service=current.services.find(s=>s.id===serviceId);if(!service)return;setEntries(rows=>[...rows,{id:crypto.randomUUID(),sourceKey:null,serviceId:service.id,slotId:null,content:service.content,provider:service.provider,serviceKind:service.serviceKind,insured:service.insured,plan:{date:current.month+'-01',start:'09:00',end:'10:00',endDate:current.month+'-01',status:'scheduled',note:''},actual:null}])}
 const monthSelection=(
<aside className="care-record-list" aria-label="第6表の月選択">
   <h2>第6表を作成</h2><label>確定済み計画版<select aria-label="確定済み計画版" value={planId} disabled={busy} onChange={e=>setPlanId(e.target.value)}><option value="">選択してください</option>{confirmed.map(p=><option key={p.id} value={p.id}>計画版 {p.version} ・ {p.effectiveFrom}～{p.effectiveTo??''}</option>)}</select></label>
   {!confirmed.length&&<p>確定済みの第3表が必要です。</p>}<label>対象年月<input type="month" value={target} onChange={e=>setTarget(e.target.value)} disabled={busy} /></label><button className="btn" disabled={busy||!planId||!target} onClick={generate}>週間計画から予定を確認</button>
   <h2>保存済みの月間予定</h2>{!list.length?<p>月間予定はまだありません。</p>:<ol>{list.map(m=><li key={m.id}><button type="button" disabled={busy} aria-pressed={current?.id===m.id} onClick={()=>select(m.id)}>{m.month} ・ 計画版 {m.planVersion}<small>{m.revision?'保存版 '+m.revision:'未保存'}</small></button></li>)}</ol>}
  </aside>
 )
 return <main className="care-record-work care-month-work">
  <header className="care-record-header"><button className="btn" disabled={busy} onClick={()=>void run(async()=>{if(await preserve()!==false)onBack()})}>ケアプランに戻る</button><h1>{clientName} さんのサービス利用票</h1>{continuous&&<button type="button" className="btn" disabled={busy} onClick={()=>setChoosing(true)}>対象月を選ぶ</button>}{onOpenFee&&view&&<div role="group" aria-label="第7表へ引き継ぐ"><button className="btn" disabled={busy||!view.revision||(!past&&dirty)} onClick={()=>onOpenFee({monthId:view.id,revision:view.revision,basis:'planned'})}>この保存版で第7表（予定）</button><button className="btn" disabled={busy||!view.revision||(!past&&dirty)} onClick={()=>onOpenFee({monthId:view.id,revision:view.revision,basis:'actual'})}>この保存版で第7表（実績）</button></div>}</header>
  <div className="care-record-columns">{(!continuous||choosing)&&(continuous?<PaperDialog title="第6表の対象月を選ぶ" onClose={()=>setChoosing(false)}>{monthSelection}</PaperDialog>:monthSelection)}<section className="care-record-editor" aria-label="第6表の編集">
   {error&&!preview&&<p role="alert" className="care-record-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
   {!view?<OfficialCareWorkspace disabled={busy} formKind="care_plan_6" onStart={() => setChoosing(true)} values={{}} title="第6表・サービス利用票" status="未作成"><p>確定した週間計画と対象年月から予定を確認してください。閲覧だけでは記録は作成されません。</p></OfficialCareWorkspace>:<OfficialCareWorkspace disabled={busy} readOnly={!!past} documentId={view.documentId} savedRevision={view.revision} revision={past?.revision} values={careMonthPrint({...view,entries:shown,headers:past?.headers??(past?undefined:headers)})} title="第6表・サービス利用票" status={past ? `保存版 ${past.revision}（閲覧のみ）` : dirty || !current?.revision ? '未保存' : '保存済み'}
     toolbar={saveButton}
     textField={(slot, binding, page)=>{
       const key=binding?.ref.key==='monthly.header'?binding.ref.path?.[0]:undefined
       if(page!==0||(key!=='insurerNumber'&&key!=='insurerName'&&key!=='insuredNumber'))return
       return {label:slot,value:shownHeaders[key],inputMode:key==='insurerName'?undefined:'numeric',maxLength:key==='insurerName'?200:12,
         onChange:value=>setHeaders(old=>({...old,[key]:value}))}
     }}
     details={shown.length?{slot:'明細',content:<CareMonthNotes entries={shown} disabled={busy||!!past} onChange={updateEntry}/>} : undefined}>
    <h2>{view.month} ・ 計画版 {view.planVersion}</h2><div className="care-record-toolbar"><span role="status">{past?'保存版 '+past.revision+'（閲覧のみ）':dirty?'保存していない変更があります':current?.revision?'保存済み':'未保存'}</span><button className="btn" disabled={busy||!view.revision||(!past&&dirty)} onClick={()=>void run(async()=>downloadBlob(await api.pdf(view.documentId,view.revision),'サービス利用票_'+view.month+'_'+clientName+'.pdf'))}>第6表PDF</button></div>
    <label>修正履歴<select aria-label="修正履歴" disabled={busy} value={past?.revision??''} onChange={e=>showRevision(e.target.value)}><option value="">現在の月間予定</option>{revisions.map(r=><option key={r.rev} value={r.rev}>保存版 {r.rev}</option>)}</select></label>
    <CareMonthHeaderFields value={past?.headers??(past?MonthHeaders.parse({}):headers)} disabled={busy||!!past} onChange={setHeaders} />
    <p>予定 {counts.planned}件 ／ 実施 {counts.actual}件 ／ 未実施 {counts.notProvided}件 ／ 実績未入力 {counts.unentered}件</p>
    {overlaps.size>0&&<p role="status">同じサービスの予定に重複があるため、{overlaps.size}件の日時を確認してください。</p>}
    {view.unexpanded.length>0&&<p role="status">週単位以外の予定 {view.unexpanded.length}件は日付を確定できないため未展開です。確認後、予定を追加してください。</p>}
    {!past&&<fieldset disabled={busy}><legend>予定の追加・見直し</legend><div className="care-month-actions"><label>追加するサービス<select aria-label="追加するサービス" value={serviceId} onChange={e=>setServiceId(e.target.value)}><option value="">選択してください</option>{current?.services.map(s=><option key={s.id} value={s.id}>{s.content} ・ {s.provider??''}</option>)}</select></label><button className="btn" disabled={!serviceId} onClick={add}>予定を追加</button><button className="btn" onClick={()=>propose('regenerate')}>再生成の差分を確認</button></div><div className="care-month-actions"><label>コピー元の前月<select aria-label="コピー元の前月" value={sourceId} onChange={e=>setSourceId(e.target.value)}><option value="">選択してください</option>{list.filter(m=>m.id!==current?.id&&m.planId===current?.planId&&m.month===monthBefore(current.month)&&m.revision>0).map(m=><option key={m.id} value={m.id}>{m.month} ・ 計画版 {m.planVersion}</option>)}</select></label><button className="btn" disabled={!sourceId} onClick={()=>propose('copy')}>前月コピーの差分を確認</button></div></fieldset>}
    {!shown.length?<p>予定はありません。</p>:shown.map((e,i)=><CareMonthEntry key={e.id} entry={e} index={i} disabled={busy||!!past} onChange={updateEntry} />)}
   </OfficialCareWorkspace>}
  </section></div>
  {preview&&<PreviewDialog title={preview.type==='create'?'月間予定の生成を確認':'月間予定の差分を確認'} onCancel={()=>{if(!busy){setPreview(undefined);createRequest.current=undefined}}}>
   {error&&<p role="alert" className="care-record-error">{error}</p>}
   {preview.type==='create'?<><p>{preview.month} ・ 計画版 {preview.data.planVersion}</p><p>予定 {preview.data.entries.length}件、週単位以外の未展開 {preview.data.unexpanded.length}件</p><ul>{preview.data.entries.slice(0,5).map(e=><li key={e.id}>{e.plan.date} {e.plan.start} {e.content}</li>)}</ul><p>既に同じ計画版・月の記録があれば、その記録を開きます。</p></>:<><p>追加 {preview.added}件 ／ 元計画にない予定 {preview.removed}件（保持） ／ コピーできない日 {preview.skipped}件</p><p>現在の修正と実績は保持します。前月の実績はコピーしません。</p></>}
   <div className="care-month-actions"><button className="btn" disabled={busy} onClick={()=>{setPreview(undefined);createRequest.current=undefined}}>キャンセル</button><button className="savebtn" disabled={busy} onClick={accept}>{preview.type==='create'?'この予定で第6表を作成':'この差分を入力に反映'}</button></div>
  </PreviewDialog>}
 </main>
}
