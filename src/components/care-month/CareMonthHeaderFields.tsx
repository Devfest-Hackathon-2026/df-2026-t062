import type { MonthHeaderValues } from '../../../core/care-month-api.ts'
export function CareMonthHeaderFields({value,disabled,onChange}:{value:MonthHeaderValues;disabled:boolean;onChange:(value:MonthHeaderValues)=>void}) {
 return <fieldset disabled={disabled}><legend>保険者情報・届出日</legend><div className="care-record-dates">
  {([['保険者番号','insurerNumber'],['保険者名','insurerName'],['被保険者番号','insuredNumber'],['届出年月日','submittedDate']] as const).map(([label,key])=><label key={key}>{label}<input aria-label={label} type={key==='submittedDate'?'date':'text'} inputMode={key==='insurerNumber'||key==='insuredNumber'?'numeric':undefined} maxLength={key==='insurerName'?200:key==='submittedDate'?10:12} value={value[key]} onChange={e=>onChange({...value,[key]:e.target.value})} /></label>)}
 </div></fieldset>
}
