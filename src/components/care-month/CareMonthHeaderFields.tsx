import type { MonthHeaderValues } from '../../../core/care-month-api.ts'
export function CareMonthHeaderFields({value,disabled,onChange}:{value:MonthHeaderValues;disabled:boolean;onChange:(value:MonthHeaderValues)=>void}) {
 return <fieldset disabled={disabled}><legend>保険者情報・届出日</legend><div className="care-record-dates">
  <label>届出年月日<input type="date" value={value.submittedDate} onChange={e=>onChange({...value,submittedDate:e.target.value})} /></label>
  <label>認定区分<select value={value.certificationStatus??''} onChange={e=>onChange({...value,certificationStatus:e.target.value as MonthHeaderValues['certificationStatus']})}><option value="">未入力</option><option>認定済</option><option>申請中</option></select></label>
  <label>フリガナ<input value={value.furigana??''} onChange={e=>onChange({...value,furigana:e.target.value})}/></label>
  <label>生年月日<input type="date" value={value.birthDate??''} onChange={e=>onChange({...value,birthDate:e.target.value})}/></label>
  <label>性別<select value={value.sex??''} onChange={e=>onChange({...value,sex:e.target.value as MonthHeaderValues['sex']})}><option value="">未入力</option><option>男</option><option>女</option></select></label>
  {(['careLevel','changedCareLevel'] as const).map(key=><label key={key}>{key==='careLevel'?'要介護状態区分':'変更後の要介護状態区分'}<select aria-label={key==='careLevel'?'要介護状態区分':'変更後の要介護状態区分'} value={value[key]??''} onChange={e=>onChange({...value,[key]:e.target.value})}><option value="">未入力</option>{[1,2,3,4,5].map(n=><option key={n}>要介護{n}</option>)}</select></label>)}
  <label>変更日<input type="date" value={value.careLevelChangeDate??''} onChange={e=>onChange({...value,careLevelChangeDate:e.target.value})}/></label>
  <label>区分支給限度基準額<input inputMode="numeric" value={value.limitUnits??''} onChange={e=>{if(/^\d{0,8}$/.test(e.target.value))onChange({...value,limitUnits:e.target.value})}}/></label>
  <label>限度額適用開始月<input type="month" value={value.limitFrom??''} onChange={e=>onChange({...value,limitFrom:e.target.value})}/></label>
  <label>限度額適用終了月<input type="month" value={value.limitTo??''} onChange={e=>onChange({...value,limitTo:e.target.value})}/></label>
  {(['previousShortStayDays','shortStayDays'] as const).map(key=><label key={key}>{key==='previousShortStayDays'?'前月までの短期入所利用日数':'短期入所利用日数'}<input inputMode="numeric" value={value[key]??''} onChange={e=>{if(/^(?:|[0-9]|[12][0-9]|3[01])$/.test(e.target.value))onChange({...value,[key]:e.target.value})}}/></label>)}
 </div></fieldset>
}
