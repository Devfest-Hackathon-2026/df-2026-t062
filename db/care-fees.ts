import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { calculateFee,FEE_MASTER,type FeeInput,type FeeResult } from '../core/care-fees.ts'
import { careFeePrint } from '../core/care-fee-print.ts'
import type { FeeCalculateInput,CareFeeCalculation,CareFeeSummary } from '../core/care-fee-api.ts'
import { getCareMonth,careMonthSaved } from './care-months.ts'
import { canonical } from './care-plans.ts'
import { verifyFeeWorkbook } from './care-fee-workbook.ts'
import { loadFormDef } from './forms.ts'
import { tx,type Db,type Tx } from './pool.ts'
import { audit,BadRequest,Conflict,NotFound,createDocumentInTx,writeField,saveDocumentInTx,type Staff } from './repo.ts'
type Q=Db|Tx
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex')
export async function careFeeMasters(db:Q) {
 const rows=(await db.query('SELECT id,content_sha256,body FROM care_fee_masters ORDER BY id')).rows
 return rows.filter(r=>r.id===FEE_MASTER.id&&r.content_sha256===hash(FEE_MASTER)&&hash(r.body)===r.content_sha256).map(r=>({id:r.id as string,hash:r.content_sha256 as string,...r.body}))
}
const QUERY=`SELECT c.*,f.month_id,f.document_id,f.basis,m.target_month,m.plan_id,p.version,r7.rev,r6.rev AS source_rev,x.confirmed_at,x.confirmed_by FROM care_fee_calculations c JOIN care_plan_fees f ON f.id=c.fee_id JOIN care_plan_months m ON m.id=f.month_id JOIN care_plans p ON p.id=m.plan_id JOIN revisions r7 ON r7.id=c.document_revision_id JOIN revisions r6 ON r6.id=c.source_revision_id LEFT JOIN care_fee_confirmations x ON x.calculation_id=c.id`
export async function careFeeCalculation(db:Q,officeId:string,feeId:string,calculationId?:string):Promise<CareFeeCalculation> {
 const r=(await db.query(QUERY+' WHERE f.id=$1 AND f.office_id=$2 AND c.office_id=$2 AND ($3::uuid IS NULL OR c.id=$3) ORDER BY r7.rev DESC LIMIT 1',[feeId,officeId,calculationId??null])).rows[0]
 if(!r)throw new NotFound()
 return {id:r.id,groupId:r.fee_id,clientId:r.client_id,monthId:r.month_id,month:r.target_month,planId:r.plan_id,planVersion:Number(r.version),documentId:r.document_id,revision:Number(r.rev),sourceRevision:Number(r.source_rev),sourceRevisionId:String(r.source_revision_id),sourceHash:r.source_hash,masterId:r.master_id,masterHash:r.master_hash,createdAt:new Date(r.created_at).toISOString(),createdBy:r.created_by,confirmedAt:r.confirmed_at?new Date(r.confirmed_at).toISOString():null,confirmedBy:r.confirmed_by??null,input:r.input as FeeInput,result:r.result as FeeResult}
}
export async function listCareFees(db:Q,officeId:string,clientId:string):Promise<CareFeeSummary[]> {
 if(!(await db.query('SELECT id FROM clients WHERE id=$1 AND office_id=$2 AND archived_at IS NULL',[clientId,officeId])).rows.length)throw new NotFound()
 return (await db.query(`SELECT f.id,f.month_id,m.target_month,f.basis,r.rev,c.result->>'status' AS status FROM care_plan_fees f JOIN care_plan_months m ON m.id=f.month_id JOIN LATERAL (SELECT x.* FROM care_fee_calculations x JOIN revisions v ON v.id=x.document_revision_id WHERE x.fee_id=f.id ORDER BY v.rev DESC LIMIT 1)c ON true JOIN revisions r ON r.id=c.document_revision_id WHERE f.office_id=$1 AND f.client_id=$2 ORDER BY m.target_month DESC,f.created_at DESC LIMIT 120`,[officeId,clientId])).rows.map(r=>({id:r.id,monthId:r.month_id,month:r.target_month,basis:r.basis,revision:Number(r.rev),status:r.status}))
}
export async function careFeeHistory(db:Q,officeId:string,feeId:string) {
 await careFeeCalculation(db,officeId,feeId)
 return (await db.query('SELECT c.id,r.rev,c.created_at FROM care_fee_calculations c JOIN revisions r ON r.id=c.document_revision_id WHERE c.fee_id=$1 AND c.office_id=$2 ORDER BY r.rev DESC',[feeId,officeId])).rows.map(r=>({id:r.id as string,revision:Number(r.rev),createdAt:new Date(r.created_at).toISOString()}))
}
export async function calculateCareFee(db:Db,staff:Staff,monthId:string,input:z.infer<typeof FeeCalculateInput>) {
 return tx(db,async c=>{
  const month=await getCareMonth(c,staff.officeId,monthId,true),inputHash=hash({monthId,input})
  const previous=(await c.query('SELECT id,fee_id,input_hash FROM care_fee_calculations WHERE office_id=$1 AND client_id=$2 AND request_id=$3',[staff.officeId,month.clientId,input.requestId])).rows[0]
  if(previous){if(previous.input_hash!==inputHash)throw new Conflict('fee_request');return careFeeCalculation(c,staff.officeId,previous.fee_id,previous.id)}
  const source=await careMonthSaved(c,staff.officeId,monthId,input.sourceRevision)
  const master=(await careFeeMasters(c)).find(m=>m.id===input.masterId)
  if(!master)throw new BadRequest('検証済みの算定マスターを選択してください')
  let fee=(await c.query('SELECT * FROM care_plan_fees WHERE month_id=$1 AND basis=$2 AND office_id=$3',[monthId,input.basis,staff.officeId])).rows[0]
  if(!fee){
   if(input.baseRevision!==0)throw new Conflict('fee_version')
   const doc=await createDocumentInTx(c,staff,month.clientId,'care_plan_7', { copySourceOnCreate: true })
   fee=(await c.query('INSERT INTO care_plan_fees(office_id,client_id,month_id,basis,document_id,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[staff.officeId,month.clientId,monthId,input.basis,doc.id,staff.id])).rows[0]
  }
  const doc=(await c.query('SELECT template_version_id FROM documents WHERE id=$1 AND office_id=$2 FOR UPDATE',[fee.document_id,staff.officeId])).rows[0]
  const latest=Number((await c.query('SELECT coalesce(max(rev),0) AS rev FROM revisions WHERE document_id=$1',[fee.document_id])).rows[0].rev)
  if(latest!==input.baseRevision)throw new Conflict('fee_version')
  const {requestId:_request,sourceRevision:_source,baseRevision:_base,...conditions}=input
  const result=await verifyFeeWorkbook(source,conditions,calculateFee(source,conditions))
  const r6=(await c.query('SELECT id,"values" FROM revisions WHERE document_id=$1 AND rev=$2 AND office_id=$3',[month.documentId,input.sourceRevision,staff.officeId])).rows[0]
  const now=new Date(),date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
  const record:CareFeeCalculation={id:crypto.randomUUID(),groupId:fee.id,clientId:month.clientId,monthId,month:month.month,planId:month.planId,planVersion:month.planVersion,documentId:fee.document_id,revision:latest+1,sourceRevision:input.sourceRevision,sourceRevisionId:String(r6.id),sourceHash:hash(source),masterId:master.id,masterHash:master.hash,createdAt:now.toISOString(),createdBy:staff.id,confirmedAt:null,confirmedBy:null,input:conditions,result}
  const form=await loadFormDef(c,doc.template_version_id),projection=careFeePrint(record,source)
  if(Object.keys(projection).some(k=>!form.keys.includes(k)))throw new BadRequest('第7表の様式に必要な明細欄がありません')
  for(const [key,value]of Object.entries({...projection,'person.name':r6.values['person.name']??null,'plan.createdDate':date}))if(form.keys.includes(key))await writeField(c,staff.officeId,month.clientId,fee.document_id,key,value,'cm',staff.id)
  const saved=await saveDocumentInTx(c,staff,fee.document_id,{scope:'document'})
  await c.query(`INSERT INTO care_fee_calculations(id,fee_id,office_id,client_id,source_revision_id,document_revision_id,source_hash,master_id,master_hash,input,result,request_id,input_hash,created_by,created_at) SELECT $1,$2,$3,$4,$5,r.id,$6,$7,$8,$9,$10,$11,$12,$13,$14 FROM revisions r WHERE r.document_id=$15 AND r.rev=$16`,[record.id,fee.id,staff.officeId,month.clientId,r6.id,record.sourceHash,master.id,master.hash,JSON.stringify(conditions),JSON.stringify(result),input.requestId,inputHash,staff.id,record.createdAt,fee.document_id,saved.rev])
  await audit(c,staff,staff.officeId,'care_fee.calculate',{clientId:month.clientId,documentId:fee.document_id},{feeId:fee.id,calculationId:record.id,sourceRevision:input.sourceRevision,masterId:master.id,status:result.status})
  return careFeeCalculation(c,staff.officeId,fee.id,record.id)
 })
}

export async function confirmCareFee(db:Db,staff:Staff,feeId:string,calculationId:string,baseRevision:number) {
 return tx(db,async c=>{
  const value=await careFeeCalculation(c,staff.officeId,feeId,calculationId)
  const month=await getCareMonth(c,staff.officeId,value.monthId,true)
  await c.query('SELECT id FROM documents WHERE id=$1 AND office_id=$2 FOR UPDATE',[value.documentId,staff.officeId])
  const existing=(await c.query('SELECT calculation_id FROM care_fee_confirmations WHERE calculation_id=$1',[calculationId])).rows[0]
  if(existing)return careFeeCalculation(c,staff.officeId,feeId,calculationId)
  if(value.sourceRevision!==month.revision)throw new Conflict('fee_source_updated')
  if(value.result.workbookCheck?.status!=='matched')throw new Conflict('fee_workbook_unverified')
  const latest=Number((await c.query('SELECT coalesce(max(rev),0) AS rev FROM revisions WHERE document_id=$1',[value.documentId])).rows[0].rev)
  if(latest!==baseRevision || value.revision!==latest || value.result.status!=='calculated')throw new Conflict('fee_confirmation')
  await c.query('INSERT INTO care_fee_confirmations(calculation_id,office_id,client_id,confirmed_by) VALUES($1,$2,$3,$4)',[calculationId,staff.officeId,value.clientId,staff.id])
  await audit(c,staff,staff.officeId,'care_fee.confirm',{clientId:value.clientId,documentId:value.documentId},{feeId,calculationId,revision:value.revision})
  return careFeeCalculation(c,staff.officeId,feeId,calculationId)
 })
}
