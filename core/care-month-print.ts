import { monthDays } from './care-month.ts'
import type { CareMonthView } from './care-month-api.ts'
const preview=(s:string|null,max:number)=>{const c=Array.from(s??'');return c.length>max?c.slice(0,max-1).join('')+'…':c.join('')}
export function careMonthPrint(month:CareMonthView) {
 const rows=month.entries.map(e=>{
  const row:Record<string,string>={id:e.id,time:e.plan.start+'\n'+(e.plan.endDate!==e.plan.date?'翌':'')+e.plan.end,content:preview(e.content,10),provider:preview(e.provider,16),totalPlan:e.plan.status==='scheduled'?'1':'0',totalActual:e.actual===null?'':e.actual.status==='provided'?'1':'0'}
  for(let d=1;d<=31;d++) {
   row['p'+d]=Number(e.plan.date.slice(-2))===d?(e.plan.status==='scheduled'?'1':e.plan.status==='cancelled'?'×':'削'):''
   row['a'+d]=e.actual?.status==='provided'?(Number(e.actual.date.slice(-2))===d && e.actual.date.startsWith(month.month+'-')?'1':''):(e.actual?.status==='not_provided' && Number(e.plan.date.slice(-2))===d?'0':'')
  }
  return row
 })
 const details=month.entries.map((e,i)=>`${i+1}. ${e.content}\n提供事業所: ${e.provider??'未入力'} / 種別: ${e.serviceKind??'未入力'} / 保険対象: ${e.insured?'対象':'対象外'}\n予定: ${e.plan.date} ${e.plan.start} ～ ${e.plan.endDate} ${e.plan.end} / ${e.plan.status==='scheduled'?'予定':e.plan.status==='cancelled'?'取消':'削除'}\n予定の補足: ${e.plan.note||'なし'}\n実績: ${e.actual===null?'未入力':e.actual.status==='not_provided'?'未実施':`${e.actual.date} ${e.actual.start} ～ ${e.actual.endDate} ${e.actual.end}`}\n実績の補足: ${e.actual?.note||'なし'}\n行ID: ${e.id}\nサービスID: ${e.serviceId} / 枠ID: ${e.slotId??'手動追加'}\n${e.copiedFrom?`コピー元: ${e.copiedFrom.monthId} 保存版${e.copiedFrom.revision} / 元行 ${e.copiedFrom.entryId} / 参照 ${e.copiedFrom.capturedAt}\n`:''}`).join('\n')
 return {'monthly.weekdays':monthDays(month.month).map(date=>({label:['日','月','火','水','木','金','土'][new Date(date+'T00:00:00Z').getUTCDay()]})),'monthly.legend':'各行は1件の予定です。取消=×、削除=削、実績未入力=空欄、未実施=0。時間変更・補足・省略した名称・未展開の予定は続く明細に記載。','monthly.monthDate':month.month+'-01','monthly.printRows':rows,'monthly.details':`${month.month} 第6表の明細\n計画版 ${month.planVersion} / 確定ID ${month.confirmationId}\n元資料SHA256: ${month.sourceHash}\n${month.unexpanded.length?'週単位以外の未展開予定:\n'+month.unexpanded.map(s=>`${s.serviceId} / ${s.slotId}: ${s.note??'内容未入力'}`).join('\n')+'\n\n':''}${details||'予定はありません。'}`}
}
