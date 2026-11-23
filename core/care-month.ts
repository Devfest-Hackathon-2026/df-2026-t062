import { z } from 'zod'
// Civil dates represent Asia/Tokyo calendar days, never the host timezone.
export const CivilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s)
export const TargetMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(s => Number(s.slice(0,4)) >= 1900 && Number(s.slice(0,4)) <= 9998)
const Time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const Period = { periodFrom: CivilDate.nullable(), periodTo: CivilDate.nullable() }
const Weekly = z.object({ slotId:z.string().min(1), weekday:z.number().int().min(1).max(7), start:Time, end:Time, endsNextDay:z.boolean(), ...Period }).refine(s=>s.endsNextDay ? s.end<s.start : s.end>s.start)
export const ConfirmedScheduleSchema = z.object({
 schemaVersion:z.literal(1), plan:z.object({ id:z.string().min(1), clientId:z.string().min(1), effectiveFrom:CivilDate, effectiveTo:CivilDate.nullable() }),
 services:z.array(z.object({ serviceId:z.string().min(1), content:z.string(), serviceKind:z.string().nullable(), provider:z.string().nullable(), insured:z.boolean(), ...Period, weekly:z.array(Weekly), other:z.array(z.object({slotId:z.string().min(1),note:z.string().nullable(),...Period})) })),
})
export type ConfirmedSchedule = z.infer<typeof ConfirmedScheduleSchema>
export const VisitPlanSchema = z.object({ date:CivilDate, start:Time, end:Time, endDate:CivilDate, status:z.enum(['scheduled','cancelled','deleted']), note:z.string().max(10000) }).strict().refine(p => p.endDate === (p.end > p.start ? p.date : nextDate(p.date)) && (p.endDate !== p.date || p.end > p.start))
export const VisitActualSchema = z.discriminatedUnion('status', [
 z.object({status:z.literal('provided'),date:CivilDate,start:Time,end:Time,endDate:CivilDate,note:z.string().max(10000)}).strict(),
 z.object({status:z.literal('not_provided'),date:z.null(),start:z.null(),end:z.null(),endDate:z.null(),note:z.string().max(10000)}).strict(),
]).refine(p=>p.status==='not_provided' || p.endDate === (p.end > p.start ? p.date : nextDate(p.date)))
export const MonthEntrySchema = z.object({ id:z.string().min(1).max(1000), sourceKey:z.string().nullable(), serviceId:z.string().min(1), slotId:z.string().nullable(), content:z.string().max(10000), serviceKind:z.string().nullable(), provider:z.string().nullable(), insured:z.boolean(), equipmentName:z.string().max(1000).optional(),taisCode:z.string().max(100).optional(),notificationCode:z.string().max(100).optional(), copiedFrom:z.object({monthId:z.uuid(),revision:z.number().int().positive(),entryId:z.string().min(1).max(1000),capturedAt:z.iso.datetime()}).strict().optional(), plan:VisitPlanSchema, actual:VisitActualSchema.nullable() }).strict()
export type MonthEntry = z.infer<typeof MonthEntrySchema>
export interface MonthExpansion { entries: MonthEntry[]; unexpanded: { serviceId:string; slotId:string; note:string|null }[] }
function nextDate(date: string) { return new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10) }
export function monthDays(month: string): string[] {
 TargetMonth.parse(month)
 const first=month+'-01', dates:string[]=[]
 for(let date=first;date.startsWith(month);date=nextDate(date)) dates.push(date)
 return dates
}
function period(date:string,from:string|null,to:string|null) { return (!from || date>=from) && (!to || date<=to) }
export function expandMonth(month:string,confirmationId:string,input:unknown):MonthExpansion {
 const days=monthDays(month), snapshot=ConfirmedScheduleSchema.parse(input)
 const ids=new Set<string>(), slots=new Set<string>()
 const entries:MonthEntry[]=[],unexpanded:MonthExpansion['unexpanded']=[]
 for(const service of snapshot.services) {
  if(ids.has(service.serviceId)) throw new Error('サービスIDが重複しています')
  ids.add(service.serviceId)
  if(service.periodFrom && service.periodTo && service.periodFrom>service.periodTo) throw new Error('サービス期間が不正です')
  for(const slot of [...service.weekly,...service.other]) {
   if(slots.has(slot.slotId) || (slot.periodFrom && slot.periodTo && slot.periodFrom>slot.periodTo)) throw new Error('時間枠IDまたは期間が不正です')
   slots.add(slot.slotId)
  }
  for(const slot of service.other) unexpanded.push({serviceId:service.serviceId,slotId:slot.slotId,note:slot.note})
  for(const slot of service.weekly) for(const date of days) {
   if((new Date(date+'T00:00:00Z').getUTCDay() || 7)!==slot.weekday || !period(date,snapshot.plan.effectiveFrom,snapshot.plan.effectiveTo) || !period(date,service.periodFrom,service.periodTo) || !period(date,slot.periodFrom,slot.periodTo)) continue
   const key=confirmationId+'/'+slot.slotId+'/'+date
   entries.push({id:'generated/'+key,sourceKey:key,serviceId:service.serviceId,slotId:slot.slotId,content:service.content,serviceKind:service.serviceKind,provider:service.provider,insured:service.insured,plan:{date,start:slot.start,end:slot.end,endDate:slot.endsNextDay?nextDate(date):date,status:'scheduled',note:''},actual:null})
  }
 }
 if(snapshot.plan.effectiveTo && snapshot.plan.effectiveFrom>snapshot.plan.effectiveTo) throw new Error('計画期間が不正です')
 entries.sort((a,b)=>a.plan.date.localeCompare(b.plan.date)||a.plan.start.localeCompare(b.plan.start)||a.id.localeCompare(b.id))
 return {entries,unexpanded}
}
/** Propose additions/removals. Adoption is explicit; existing edits and actuals are never overwritten. */
export function mergeMonthGeneration(current:MonthEntry[],generated:MonthEntry[]) {
 const existing=new Set(current.filter(e=>e.sourceKey).map(e=>e.sourceKey)), upcoming=new Set(generated.map(e=>e.sourceKey))
 const added=generated.filter(e=>!existing.has(e.sourceKey))
 const removed=current.filter(e=>e.sourceKey && !upcoming.has(e.sourceKey))
 return {entries:[...structuredClone(current),...structuredClone(added)],added,removed}
}
/** Copy same day-of-month, without silently clamping 29/30/31. Never copy actuals. */
export function copyMonth(source:MonthEntry[],target:string,current:MonthEntry[]) {
 const dates=new Set(monthDays(target)), ids=new Set(current.map(e=>e.id)), skipped:MonthEntry[]=[], added:MonthEntry[]=[]
 if(current.some(e=>!e.plan.date.startsWith(target+'-'))) throw new Error('対象月が異なります')
 const first=new Date(target+'-01T00:00:00Z');first.setUTCMonth(first.getUTCMonth()-1)
 const previous=first.toISOString().slice(0,7)
 if(source.some(e=>!e.plan.date.startsWith(previous+'-'))) throw new Error('前月の記録ではありません')
 for(const row of source) {
  if(row.plan.status==='deleted') continue
  const date=target+row.plan.date.slice(7),id='copy/'+target+'/'+row.id
  if(!dates.has(date)) { skipped.push(row);continue }
  if(ids.has(id)) continue
  const copy:MonthEntry={...structuredClone(row),id,sourceKey:null,slotId:null,plan:{...row.plan,date,endDate:row.plan.endDate===row.plan.date?date:nextDate(date)},actual:null}
  added.push(copy);ids.add(id)
 }
 return {entries:[...structuredClone(current),...added],added,skipped}
}
export function monthCounts(entries:MonthEntry[]) {
 return {planned:entries.filter(e=>e.plan.status==='scheduled').length,actual:entries.filter(e=>e.actual?.status==='provided').length,notProvided:entries.filter(e=>e.actual?.status==='not_provided').length,unentered:entries.filter(e=>e.actual===null).length}
}
/** IDs whose active plans overlap another occurrence of the same stable service. */
export function monthOverlaps(entries:MonthEntry[]):Set<string> {
 const rows=entries.filter(e=>e.plan.status==='scheduled').map(e=>({id:e.id,serviceId:e.serviceId,start:Date.parse(e.plan.date+'T'+e.plan.start+':00Z'),end:Date.parse(e.plan.endDate+'T'+e.plan.end+':00Z')})).filter(e=>Number.isFinite(e.start)&&Number.isFinite(e.end)).sort((a,b)=>a.serviceId.localeCompare(b.serviceId)||a.start-b.start||b.end-a.end)
 const conflicts=new Set<string>();let longest:typeof rows[number]|undefined
 for(const row of rows){if(!longest||longest.serviceId!==row.serviceId||longest.end<=row.start){longest=row;continue}conflicts.add(longest.id);conflicts.add(row.id);if(row.end>longest.end)longest=row}
 return conflicts
}
