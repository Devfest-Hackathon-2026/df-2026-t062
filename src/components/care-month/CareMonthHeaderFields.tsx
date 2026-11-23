import type { MonthHeaderValues } from '../../../core/care-month-api.ts'
export function CareMonthHeaderFields({value,disabled,onChange}:{value:MonthHeaderValues;disabled:boolean;onChange:(value:MonthHeaderValues)=>void}) {
 return <fieldset disabled={disabled}><legend>保険者情報・届出日</legend><div className="care-record-dates">
  <label>届出年月日<input type="date" value={value.submittedDate} onChange={e=>onChange({...value,submittedDate:e.target.value})} /></label>
 </div></fieldset>
}
