import { sameValue } from '../core/apply-batch.ts'
import { tx,type Db } from './pool.ts'
import { audit,BadRequest,Conflict,lockDocument,readFields,type Staff } from './repo.ts'
export interface ReviewField {key:string;valueVersion:string;base:unknown}
/** 画面に表示した値・更新時刻の両方を確認する。保存や作者(by)は変えない。 */
export async function reviewFields(db:Db,staff:Staff,id:string,input:{formVersionId:string;fields:ReviewField[];reviewed:boolean}) {
 return tx(db,async c=>{
  const d=await lockDocument(c,staff.officeId,id)
  if(d.versionId!==input.formVersionId)throw new Conflict('form_version')
  const fields=await readFields(c,id)
  if(new Set(input.fields.map(f=>f.key)).size!==input.fields.length)throw new BadRequest('欄が重複しています')
  for(const f of input.fields){const now=fields[f.key];if(!now||now.valueVersion!==f.valueVersion||!sameValue(now.value,f.base))throw new Conflict('review_value')}
  await c.query('UPDATE field_values SET reviewed_at=CASE WHEN $3 THEN now() ELSE NULL END, reviewed_by=CASE WHEN $3 THEN $4::uuid ELSE NULL END WHERE document_id=$1 AND key=ANY($2::text[])',[id,input.fields.map(f=>f.key),input.reviewed,staff.id])
  await audit(c,staff,staff.officeId,input.reviewed?'document.review':'document.unreview',{documentId:id,clientId:d.clientId},{fields:input.fields.length})
 })
}
/** 一般書類の、確認済みで現在値と一致する保存版を正式版にする。計画表は既存の専用確定APIを使う。 */
export async function confirmDocument(db:Db,staff:Staff,id:string,baseRev:number) {
 return tx(db,async c=>{
  const d=await lockDocument(c,staff.officeId,id)
  if(/^care_plan_[1-7]$/.test(d.kind))throw new BadRequest('ケアプランは専用の確定操作を使用してください')
  const r=(await c.query('SELECT rev,"values",template_version_id FROM revisions WHERE document_id=$1 ORDER BY rev DESC LIMIT 1',[id])).rows[0]
  if(!r||Number(r.rev)!==baseRev)throw new Conflict('revision')
  if(r.template_version_id!==d.versionId)throw new Conflict('form_version')
  const fields=await readFields(c,id)
  const values=Object.fromEntries(Object.entries(fields).map(([k,f])=>[k,f.value]))
  if(!Object.keys(values).length)throw new BadRequest('入力内容がありません')
  if(!sameValue(r.values,values))throw new Conflict('unsaved_fields')
  if(Object.values(fields).some(f=>!f.reviewedAt))throw new Conflict('unreviewed_fields')
  await c.query('INSERT INTO document_confirmations(document_id,rev,confirmed_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,baseRev,staff.id])
  await audit(c,staff,staff.officeId,'document.confirm',{documentId:id,clientId:d.clientId},{rev:baseRev})
 })
}
