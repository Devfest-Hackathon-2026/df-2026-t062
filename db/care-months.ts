import { createHash } from 'node:crypto'
import { careMonthPrint } from '../core/care-month-print.ts'
import { loadFormDef } from './forms.ts'
import { z } from 'zod'
import { ConfirmedScheduleSchema, expandMonth, mergeMonthGeneration, copyMonth, MonthEntrySchema, monthDays, type MonthEntry } from '../core/care-month.ts'
import { MonthHeaders } from '../core/care-month-api.ts'
import type { CareMonthView, CareMonthSummary, CareMonthSaved, MonthCreateInput, MonthSaveInput, MonthActionInput } from '../core/care-month-api.ts'
import { tx, type Db, type Tx } from './pool.ts'
import { audit, BadRequest, Conflict, createDocumentInTx, writeField, saveDocumentInTx, NotFound, type Staff } from './repo.ts'
type Q=Db|Tx
function canonical(value:unknown):string { if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value && typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';return JSON.stringify(value) }
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex')
async function client(db:Q,officeId:string,clientId:string,lock=false) { if(!(await db.query(`SELECT id FROM clients WHERE id=$1 AND office_id=$2 AND archived_at IS NULL${lock?' FOR UPDATE':''}`,[clientId,officeId])).rows.length)throw new NotFound() }
async function source(db:Q,officeId:string,clientId:string,planId:string) {
 const r=(await db.query(`SELECT p.version,c.id,c.snapshot,c.snapshot_sha256 FROM care_plans p JOIN care_plan_confirmations c ON c.plan_id=p.id WHERE p.id=$1 AND p.office_id=$2 AND p.client_id=$3`,[planId,officeId,clientId])).rows[0]
 if(!r)throw new NotFound()
 const snapshot=ConfirmedScheduleSchema.parse(r.snapshot)
 if(snapshot.plan.id!==planId || snapshot.plan.clientId!==clientId || hash(r.snapshot)!==r.snapshot_sha256)throw new Conflict('month_source')
 return {confirmationId:r.id as string,sourceHash:r.snapshot_sha256 as string,planVersion:Number(r.version),snapshot}
}
export async function previewCareMonth(db:Q,officeId:string,clientId:string,planId:string,month:string) {
 await client(db,officeId,clientId)
 const s=await source(db,officeId,clientId,planId)
 return {...s,...expandMonth(month,s.confirmationId,s.snapshot)}
}
export async function getCareMonth(db:Q,officeId:string,id:string,lock=false):Promise<CareMonthView> {
 const r=(await db.query(`SELECT m.*,p.version,(SELECT coalesce(max(rev),0) FROM revisions WHERE document_id=m.document_id) AS revision FROM care_plan_months m JOIN care_plans p ON p.id=m.plan_id WHERE m.id=$1 AND m.office_id=$2${lock?' FOR UPDATE OF m':''}`,[id,officeId])).rows[0]
 if(!r)throw new NotFound()
 const header=(await db.query("SELECT value FROM field_values WHERE document_id=$1 AND key='monthly.header'",[r.document_id])).rows[0]
 const s=await source(db,officeId,r.client_id,r.plan_id)
 if(s.confirmationId!==r.confirmation_id || s.sourceHash!==r.source_hash)throw new Conflict('month_source')
 return {...(header?{headers:MonthHeaders.parse(header.value)}:{}),id:r.id,clientId:r.client_id,planId:r.plan_id,planVersion:Number(r.version),confirmationId:r.confirmation_id,sourceHash:r.source_hash,month:r.target_month,documentId:r.document_id,lockVersion:Number(r.lock_version),revision:Number(r.revision),services:s.snapshot.services.map(v=>({id:v.serviceId,content:v.content,provider:v.provider,serviceKind:v.serviceKind,insured:v.insured})),entries:z.array(MonthEntrySchema).parse(r.entries),unexpanded:expandMonth(r.target_month,r.confirmation_id,s.snapshot).unexpanded}
}
export async function listCareMonths(db:Q,officeId:string,clientId:string) {
 await client(db,officeId,clientId)
 const rows=(await db.query(`SELECT m.id,m.target_month,m.plan_id,p.version,(SELECT coalesce(max(rev),0) FROM revisions WHERE document_id=m.document_id) AS revision FROM care_plan_months m JOIN care_plans p ON p.id=m.plan_id WHERE m.office_id=$1 AND m.client_id=$2 ORDER BY m.target_month DESC,m.created_at DESC LIMIT 120`,[officeId,clientId])).rows
 return rows.map((r):CareMonthSummary=>({id:r.id,month:r.target_month,planId:r.plan_id,planVersion:Number(r.version),revision:Number(r.revision)}))
}
export async function createCareMonth(db:Db,staff:Staff,clientId:string,input:z.infer<typeof MonthCreateInput>) {
 return tx(db,async c=>{
  await client(c,staff.officeId,clientId,true)
  const s=await previewCareMonth(c,staff.officeId,clientId,input.planId,input.month)
  if(s.confirmationId!==input.confirmationId || s.sourceHash!==input.sourceHash)throw new Conflict('month_source')
  const previous=(await c.query('SELECT id,plan_id,target_month FROM care_plan_months WHERE office_id=$1 AND client_id=$2 AND request_id=$3',[staff.officeId,clientId,input.requestId])).rows[0]
  if(previous && (previous.plan_id!==input.planId || previous.target_month!==input.month))throw new Conflict('month_request')
  const old=previous??(await c.query('SELECT id FROM care_plan_months WHERE plan_id=$1 AND target_month=$2',[input.planId,input.month])).rows[0]
  if(old)return {month:await getCareMonth(c,staff.officeId,old.id),created:false}
  const doc=await createDocumentInTx(c,staff,clientId,'care_plan_6')
  const r=(await c.query(`INSERT INTO care_plan_months (office_id,client_id,plan_id,confirmation_id,document_id,target_month,request_id,source_hash,entries,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[staff.officeId,clientId,input.planId,s.confirmationId,doc.id,input.month,input.requestId,s.sourceHash,JSON.stringify(s.entries),staff.id])).rows[0]
  await audit(c,staff,staff.officeId,'care_month.create',{clientId,documentId:doc.id},{monthId:r.id,confirmationId:s.confirmationId,month:input.month})
  return {month:await getCareMonth(c,staff.officeId,r.id),created:true}
 })
}
export async function previewMonthAction(db:Db,officeId:string,id:string,input:z.infer<typeof MonthActionInput>) {
 const current=await getCareMonth(db,officeId,id)
 if(current.lockVersion!==input.baseVersion)throw new Conflict('month_version')
 if(input.action==='regenerate') {
  const generated=await previewCareMonth(db,officeId,current.clientId,current.planId,current.month)
  return {...mergeMonthGeneration(current.entries,generated.entries),skipped:[] as MonthEntry[]}
 }
 const from=await getCareMonth(db,officeId,input.sourceMonthId)
 if(from.clientId!==current.clientId || from.planId!==current.planId)throw new NotFound()
 if(!from.revision)throw new BadRequest('コピー元の前月を保存してください')
 const saved=await careMonthSaved(db,officeId,from.id,from.revision)
 try {
  const result=copyMonth(saved.month.entries,current.month,current.entries),capturedAt=new Date().toISOString()
  const added=result.added.map(e=>({...e,copiedFrom:{monthId:from.id,revision:from.revision,entryId:e.id.slice(('copy/'+current.month+'/').length),capturedAt}}))
  return {entries:[...current.entries,...added],added,skipped:result.skipped,removed:[] as MonthEntry[]}
 } catch { throw new BadRequest('同じ計画版の前月を選択してください') }
}
export async function saveCareMonth(db:Db,staff:Staff,id:string,input:z.infer<typeof MonthSaveInput>) {
 return tx(db,async c=>{
  const current=await getCareMonth(c,staff.officeId,id,true),inputHash=hash(input)
  const replay=(await c.query('SELECT input_hash FROM care_plan_month_operations WHERE month_id=$1 AND request_id=$2',[id,input.requestId])).rows[0]
  if(replay){if(replay.input_hash!==inputHash)throw new Conflict('month_request');return current}
  if(current.lockVersion!==input.baseVersion)throw new Conflict('month_version')
  const s=await source(c,staff.officeId,current.clientId,current.planId),services=new Map(s.snapshot.services.map(s=>[s.serviceId,s]))
  const allowed=new Map(expandMonth(current.month,current.confirmationId,s.snapshot).entries.map(e=>[e.sourceKey,e])),ids=new Set<string>()
  const days=new Set(monthDays(current.month))
  const existingRows=new Map(current.entries.map(e=>[e.id,e])),copiedSources=new Map<string,CareMonthSaved>()
  for(const e of input.entries) {
   const old=existingRows.get(e.id)
   if(old?.copiedFrom && canonical(old.copiedFrom)!==canonical(e.copiedFrom??null))throw new BadRequest('コピー元の保存版は変更できません')
   if(e.copiedFrom && !old?.copiedFrom) {
    const ref=e.copiedFrom,key=ref.monthId+'/'+ref.revision
    let saved=copiedSources.get(key)
    if(!saved){saved=await careMonthSaved(c,staff.officeId,ref.monthId,ref.revision);copiedSources.set(key,saved)}
    const sourceRow=saved.month.entries.find(v=>v.id===ref.entryId),date=new Date(current.month+'-01T00:00:00Z');date.setUTCMonth(date.getUTCMonth()-1)
    if(saved.month.clientId!==current.clientId || saved.month.planId!==current.planId || saved.month.month!==date.toISOString().slice(0,7) || !sourceRow || sourceRow.serviceId!==e.serviceId || e.id!=='copy/'+current.month+'/'+ref.entryId || e.sourceKey!==null)throw new BadRequest('コピー元の保存版と予定が一致しません')
    e.copiedFrom={...ref,capturedAt:new Date().toISOString()}
   }
   const original=e.sourceKey?allowed.get(e.sourceKey):undefined
   if(ids.has(e.id) || !days.has(e.plan.date) || (e.actual?.status==='provided' && !days.has(e.actual.date)) || !services.has(e.serviceId) || (e.sourceKey && (!original || original.id!==e.id || original.serviceId!==e.serviceId || original.slotId!==e.slotId)) || (!e.sourceKey && e.slotId!==null))throw new BadRequest('月間予定のID・日付・サービスが正しくありません')
   ids.add(e.id)
  }
  // Existing actuals cannot disappear merely because a planned event was removed from the submitted list.
  if(current.entries.some(e=>e.actual!==null && !ids.has(e.id)))throw new BadRequest('実績のある予定は削除状態として残してください')
  await c.query('UPDATE care_plan_months SET entries=$1,lock_version=lock_version+1,updated_at=now() WHERE id=$2',[JSON.stringify(input.entries),id])
  const next=await getCareMonth(c,staff.officeId,id)
  const form=await loadFormDef(c,(await c.query('SELECT template_version_id FROM documents WHERE id=$1 FOR UPDATE',[current.documentId])).rows[0].template_version_id)
  if(input.headers!==undefined)next.headers=input.headers
  const projection=careMonthPrint(next)
  if(Object.keys(projection).some(k=>!form.keys.includes(k)))throw new BadRequest('第6表の様式に必要な明細欄がありません')
  for(const [key,value] of Object.entries(projection))await writeField(c,staff.officeId,current.clientId,current.documentId,key,value,'cm',staff.id)
  const saved=await saveDocumentInTx(c,staff,current.documentId,{scope:'document'})
  await c.query('INSERT INTO care_plan_month_versions(month_id,revision_id,lock_version,entries) SELECT $1,r.id,$2,$3 FROM revisions r WHERE r.document_id=$4 AND r.rev=$5',[id,next.lockVersion,JSON.stringify(input.entries),current.documentId,saved.rev])
  await c.query('INSERT INTO care_plan_month_operations(month_id,request_id,input_hash) VALUES($1,$2,$3)',[id,input.requestId,inputHash])
  await audit(c,staff,staff.officeId,'care_month.edit',{clientId:current.clientId,documentId:current.documentId},{monthId:id,entries:input.entries.length})
  return getCareMonth(c,staff.officeId,id)
 })
}
/** Specific saved revision is the only future fee-calculation input; current drafts are excluded. */
export async function careMonthSaved(db:Q,officeId:string,id:string,revision:number):Promise<CareMonthSaved> {
 const month=await getCareMonth(db,officeId,id)
 const r=(await db.query(`SELECT v.entries,v.lock_version,v.saved_at,r.rev,r."values" AS saved_values FROM care_plan_month_versions v JOIN revisions r ON r.id=v.revision_id WHERE v.month_id=$1 AND r.office_id=$2 AND r.rev=$3`,[id,officeId,revision])).rows[0]
 if(!r)throw new NotFound()
 const {headers:_current,...snapshot}=month
 const headers=r.saved_values['monthly.header']
 return {month:{...snapshot,...(headers!==undefined?{headers:MonthHeaders.parse(headers)}:{}),entries:z.array(MonthEntrySchema).parse(r.entries),lockVersion:Number(r.lock_version),revision:Number(r.rev)},revision:Number(r.rev),savedAt:new Date(r.saved_at).toISOString()}
}
