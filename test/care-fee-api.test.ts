import { FEE_MASTER } from '../core/care-fees.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before,after,test } from 'node:test'
import { createPool,type Db } from '../db/pool.ts'
import { migrate } from '../db/migrate.ts'
import { seed } from '../db/seed.ts'
import { createApiServer } from '../api/server.ts'
import { DevVerifier } from '../api/auth.ts'
import { LocalStorage } from '../api/storage.ts'
import { createCarePlan,saveCarePlanNeeds,saveCarePlanSchedule,saveCarePlan,confirmCarePlan } from '../db/care-plans.ts'
import { type Staff } from '../db/repo.ts'
import type { CareMonthView } from '../core/care-month-api.ts'
const url=process.env.DATABASE_URL,skip=!url,schema=`t_care_fee_${process.pid}`
let db:Db,root='',origin='',clientId='',staff:Staff,planId='';let close=async()=>{}
const call=async(path:string,method='GET',value?:unknown,auth='Bearer dev:fees@example.com')=>{const r=await fetch(origin+path,{method,headers:{Authorization:auth,'Content-Type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});return {status:r.status,body:r.headers.get('content-type')?.includes('json')?await r.json():await r.arrayBuffer()}}
before(async()=>{
 if(!url)return
 const admin=await createPool({DATABASE_URL:url});await admin.query(`CREATE SCHEMA ${schema}`);await admin.end();db=await createPool({DATABASE_URL:url,DB_SCHEMA:schema});await migrate(db)
 const s=await seed(db,{email:'fees@example.com'});clientId=s.clients.sato;staff=s.staff;await seed(db,{email:'other-fees@example.com',officeName:'別事業所'})
 let plan=await createCarePlan(db,staff,clientId,{effectiveFrom:'2026-06-01',effectiveTo:'2026-11-30',copyFromPlanId:null})
 plan=await saveCarePlanNeeds(db,staff,plan.id,plan.lockVersion,[{need:'外出を続けたい',longGoal:{goal:'在宅生活'},shortGoals:[{goal:'安全に外出',services:[{content:'架空訪問介護',provider:'架空事業所',kind:'訪問介護',insured:true}]}]}])
 plan=await saveCarePlanSchedule(db,staff,plan.id,plan.lockVersion,[{serviceId:plan.needs[0].shortGoals[0].services[0].id,scheduleType:'weekly',weekday:1,start:'09:00',end:'09:25'}])
 const saved=await saveCarePlan(db,staff,plan.id,plan.lockVersion);await confirmCarePlan(db,staff,plan.id,saved.plan.lockVersion);planId=plan.id
 root=await mkdtemp(join(tmpdir(),'care-month-api-'));const storage=new LocalStorage(root)
 const {ensurePdf}=await import('../forms/admin/pdf.ts'),{putFormAssets}=await import('../forms/admin/assets.ts'),{readMeta}=await import('../forms/admin/files.ts')
 for(const kind of ['care_plan_6','care_plan_7']){const source=await ensurePdf(kind);assert.ok(source.pdf);await putFormAssets(storage,readMeta(kind),source.pdf,{images:false})}
 const server=createApiServer({db:async()=>db,verifier:()=>new DevVerifier(),storage:()=>storage,devAuth:true,queue:()=>({async enqueue(){},async enqueueFormImport(){},async enqueueInspection(){}})})
 server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');origin=`http://127.0.0.1:${a.port}`;close=()=>new Promise(resolve=>server.close(()=>resolve()))
})
after(async()=>{if(!url)return;await close();await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();await rm(root,{recursive:true,force:true})})
async function createMonth(){const path=`/api/clients/${clientId}/care-plan-months`;const p=await call(path+'/preview','POST',{planId,month:'2026-06'});assert.equal(p.status,200);const r=await call(path,'POST',{planId,month:'2026-06',confirmationId:p.body.confirmationId,sourceHash:p.body.sourceHash,requestId:randomUUID()});assert.equal(r.status,201);const month=r.body.month as CareMonthView;const saved=await call('/api/care-plan-months/'+month.id,'PUT',{requestId:randomUUID(),baseVersion:month.lockVersion,entries:month.entries});assert.equal(saved.status,200);return saved.body.month as CareMonthView}
async function pdfText(data:ArrayBuffer){const{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const load=getDocument({data:new Uint8Array(data)}),doc=await load.promise;let text='';for(let i=1;i<=doc.numPages;i++)text+=(await(await doc.getPage(i)).getTextContent()).items.map(t=>'str'in t?t.str:'').join('');await load.destroy();return text}
test('第7表: 特定の第6表保存版・マスター・条件を固定し、再送/409/再計算/旧版PDFを保護する',{skip},async()=>{
 const month=await createMonth(),path='/api/care-plan-months/'+month.id+'/fees',service=month.services[0].id
 const input={masterId:FEE_MASTER.id,basis:'planned',region:'other',careLevel:'要介護1',copay:1,scopeConfirmed:true,codes:{[service]:'111111'},standardMinutes:{[service]:25},requestId:randomUUID(),sourceRevision:1,baseRevision:0}
 const first=await call(path,'POST',input);assert.equal(first.status,200,JSON.stringify(first.body));const calc=first.body.calculation
 assert.equal(calc.result.status,'calculated');assert.equal(calc.result.units,1220);assert.equal(calc.result.patient,1220);assert.equal(calc.sourceRevision,1);assert.equal(calc.revision,1)
 assert.equal((await call(path,'POST',input)).body.calculation.id,calc.id)
 assert.equal((await call(path,'POST',{...input,copay:2})).status,409)
 assert.equal((await call(path,'POST',{...input,requestId:randomUUID()})).status,409)
 const entries=structuredClone(month.entries);entries[0].plan.status='cancelled';entries[0].actual={status:'not_provided',date:null,start:null,end:null,endDate:null,note:'架空の中止'}
 const changed=await call('/api/care-plan-months/'+month.id,'PUT',{requestId:randomUUID(),baseVersion:month.lockVersion,entries});assert.equal(changed.status,200)
 const unchanged=await call('/api/care-plan-fees/'+calc.groupId);assert.equal(unchanged.body.calculation.result.units,1220);assert.equal(unchanged.body.calculation.sourceHash,calc.sourceHash)
 const second=await call(path,'POST',{...input,requestId:randomUUID(),sourceRevision:2,baseRevision:1});assert.equal(second.status,200);assert.equal(second.body.calculation.revision,2);assert.equal(second.body.calculation.result.units,976);assert.notEqual(second.body.calculation.sourceHash,calc.sourceHash)
 const old=await call(`/api/care-plan-fees/${calc.groupId}/calculations/${calc.id}`);assert.deepEqual(old.body.calculation,calc)
 assert.equal((await call('/api/care-plan-fees/'+calc.groupId+'/history')).body.history.length,2)
 const pdf=await call(`/api/documents/${calc.documentId}/pdf?rev=1`);assert.equal(pdf.status,200,JSON.stringify(pdf.body));const printed=await pdfText(pdf.body);assert.ok(printed.includes('1220'));assert.ok(!printed.includes('976'))
 assert.equal((await call(`/api/documents/${calc.documentId}/fields`,'PATCH',{changes:[{key:'fees.limit',base:16765,value:999999}]})).status,409)
 assert.equal((await call(`/api/documents/${calc.documentId}/save`,'POST',{scope:'document'})).status,409)
 await assert.rejects(db.query("UPDATE care_fee_masters SET body='{}' WHERE id=$1",[FEE_MASTER.id]),{code:'23514'})
 await assert.rejects(db.query("DELETE FROM care_fee_calculations WHERE id=$1",[calc.id]),{code:'23514'})
 assert.equal((await call('/api/care-plan-fees/'+calc.groupId,'GET',undefined,'Bearer dev:other-fees@example.com')).status,404)
 assert.equal((await call(path,'POST',input,'Bearer dev:other-fees@example.com')).status,404)
 assert.equal((await call('/api/care-plan-fees/'+calc.groupId,'GET',undefined,'')).status,401)
 const missing=await call(path,'POST',{...input,requestId:randomUUID(),basis:'actual',baseRevision:0,codes:{[service]:'UNKNOWN'},sourceRevision:2});assert.equal(missing.status,200);const review=missing.body.calculation
 assert.equal(review.result.status,'needs_review');assert.equal(review.result.gross,null);assert.equal(review.result.patient,null);assert.equal(review.result.units,null)
 const raw=(await call('/api/documents/'+review.documentId)).body.document
 assert.equal(raw.saved['fees.row'].value.gross,'');assert.equal(raw.saved['fees.limit']?.value??null,null)
 const pendingPdf=await call(`/api/documents/${review.documentId}/pdf?rev=1`);assert.equal(pendingPdf.status,200,JSON.stringify(pendingPdf.body));assert.ok((await pdfText(pendingPdf.body)).includes('未計算'))
 assert.equal((await call(path,'POST',{...input,requestId:randomUUID(),masterId:'unknown'})).status,400)
 assert.equal((await call(path,'POST',{...input,requestId:randomUUID(),sourceRevision:999})).status,404)
 const list=await call(`/api/clients/${clientId}/care-plan-fees`);assert.equal(list.body.fees.length,2)
})
