import {loadFormDef} from '../../db/forms.ts'
import {tx,type Db} from '../../db/pool.ts'
import * as ins from '../../db/inspections.ts'
import {sameValue} from '../../core/apply-batch.ts'
import type {InspectDoc} from './index.ts'
/** 同じスナップショットで対象と参考資料を読む。点検のための保存・書き換えはしない。 */
export function collectInspection(db:Db,claimed:ins.ClaimedInspection) {
 return tx(db,async c=>{
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  const target=await ins.inspectionTarget(c,claimed.officeId,claimed.clientId,claimed.documentId??undefined)
  const rows=(await c.query(`SELECT d.id,d.kind,d.template_version_id,k.name AS kind_name,
    (SELECT coalesce(max(rev),0) FROM revisions r WHERE r.document_id=d.id) AS rev
    FROM documents d JOIN form_kinds k ON k.key=d.kind
    WHERE d.office_id=$1 AND d.client_id=$2 AND (d.id=$3 OR
      ($4 AND (k.is_primary OR d.id IN (SELECT peer.document_id FROM care_plan_documents own JOIN care_plan_documents peer ON peer.plan_id=own.plan_id WHERE own.document_id=$3))))
    ORDER BY (d.id=$3) DESC,d.kind,d.id`,[claimed.officeId,claimed.clientId,target.id,/^care_plan_[1-3]$/.test(target.kind)])).rows
  const availableKinds=(await c.query('SELECT DISTINCT kind FROM documents WHERE office_id=$1 AND client_id=$2',[claimed.officeId,claimed.clientId])).rows.map(r=>r.kind as string)
  const docs:InspectDoc[]=[],contextDocs:InspectDoc[]=[],inputs:ins.InspectionInput[]=[]
  for(const r of rows){
   const values=await ins.currentValues(c,r.id)
   const saved=Object.fromEntries((await c.query('SELECT key,value FROM document_saved WHERE document_id=$1',[r.id])).rows.map(row=>[row.key,row.value]))
   const role=r.id===target.id?'target':'reference'
   const doc={id:r.id,kind:r.kind,kindName:r.kind_name,form:await loadFormDef(c,r.template_version_id),values}
   ;(role==='target'?docs:contextDocs).push(doc)
   inputs.push({documentId:r.id,kind:r.kind,rev:Number(r.rev),unsaved:!sameValue(values,saved),role,formVersionId:r.template_version_id})
  }
  return {docs,contextDocs,inputs,availableKinds,target}
 })
}
