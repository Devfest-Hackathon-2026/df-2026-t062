import type { MonthEntry } from '../../../core/care-month.ts'
function nextDate(date:string) { return new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10) }
export function CareMonthEntry({ entry, index, disabled, onChange }: { entry:MonthEntry;index:number;disabled:boolean;onChange:(entry:MonthEntry)=>void }) {
 const label='予定'+(index+1)
 const setPlan=(patch:Partial<MonthEntry['plan']>)=>{
  const plan={...entry.plan,...patch}
  if(plan.date && plan.start && plan.end)plan.endDate=plan.end>plan.start?plan.date:nextDate(plan.date)
  onChange({...entry,plan})
 }
 const setActual=(patch:Record<string,string>)=>{
  if(entry.actual?.status!=='provided')return
  const actual={...entry.actual,...patch}
  if(actual.date && actual.start && actual.end)actual.endDate=actual.end>actual.start?actual.date:nextDate(actual.date)
  onChange({...entry,actual})
 }
 return <fieldset className="care-month-entry" disabled={disabled} aria-label={label}>
  <legend>{index+1}. {entry.content}</legend>
  <p>{entry.provider||'提供事業所未入力'} ・ {entry.plan.status==='scheduled'?'予定あり':entry.plan.status==='cancelled'?'取消':'削除'} ／ 実績：{entry.actual===null?'未入力':entry.actual.status==='provided'?'実施':'未実施'}</p>
  <div className="care-record-dates"><label>予定日<input aria-label={label+'の日付'} type="date" value={entry.plan.date} onChange={e=>setPlan({date:e.target.value})} /></label><label>開始<input aria-label={label+'の開始'} type="time" value={entry.plan.start} onChange={e=>setPlan({start:e.target.value})} /></label><label>終了<input aria-label={label+'の終了'} type="time" value={entry.plan.end} onChange={e=>setPlan({end:e.target.value})} /></label></div>
  {entry.plan.endDate!==entry.plan.date&&<p>終了は翌日 {entry.plan.endDate}</p>}
  {entry.actual?.status==='provided'&&(entry.actual.date!==entry.plan.date||entry.actual.start!==entry.plan.start||entry.actual.end!==entry.plan.end||entry.actual.endDate!==entry.plan.endDate||entry.plan.status!=='scheduled')&&<p>実績が予定と異なります。予定・実績はそれぞれ保持しています。</p>}
  <div className="care-month-actions"><button className="btn" type="button" onClick={()=>setPlan({status:entry.plan.status==='scheduled'?'cancelled':'scheduled'})}>{entry.plan.status==='scheduled'?'取り消す':'再開する'}</button>{entry.plan.status!=='deleted'&&<button className="btn" type="button" onClick={()=>setPlan({status:'deleted'})}>予定を削除</button>}</div>
  <label>実績<select aria-label={'実績'+(index+1)} value={entry.actual?.status??''} onChange={e=>onChange({...entry,actual:e.target.value==='provided'?{status:'provided',date:entry.plan.date,start:entry.plan.start,end:entry.plan.end,endDate:entry.plan.endDate,note:entry.actual?.note??''}:e.target.value==='not_provided'?{status:'not_provided',date:null,start:null,end:null,endDate:null,note:entry.actual?.note??''}:null})}><option value="">未入力</option><option value="provided">実施</option><option value="not_provided">未実施</option></select></label>
  {entry.actual?.status==='provided'&&<div className="care-record-dates"><label>実績日<input aria-label={'実績'+(index+1)+'の日付'} type="date" value={entry.actual.date} onChange={e=>setActual({date:e.target.value})} /></label><label>実績開始<input aria-label={'実績'+(index+1)+'の開始'} type="time" value={entry.actual.start} onChange={e=>setActual({start:e.target.value})} /></label><label>実績終了<input aria-label={'実績'+(index+1)+'の終了'} type="time" value={entry.actual.end} onChange={e=>setActual({end:e.target.value})} /></label></div>}
 </fieldset>
}
