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
const url=process.env.DATABASE_URL,skip=!url,schema=`t_care_month_${process.pid}`
let db:Db,root='',origin='',clientId='',staff:Staff,planId='';let close=async()=>{}
const call=async(path:string,method='GET',value?:unknown,auth='Bearer dev:months@example.com')=>{const r=await fetch(origin+path,{method,headers:{Authorization:auth,'Content-Type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});return {status:r.status,body:r.headers.get('content-type')?.includes('json')?await r.json():await r.arrayBuffer()}}
before(async()=>{
 if(!url)return
 const admin=await createPool({DATABASE_URL:url});await admin.query(`CREATE SCHEMA ${schema}`);await admin.end();db=await createPool({DATABASE_URL:url,DB_SCHEMA:schema});await migrate(db)
 const s=await seed(db,{email:'months@example.com'});clientId=s.clients.sato;staff=s.staff;await seed(db,{email:'other-months@example.com',officeName:'別事業所'})
 let plan=await createCarePlan(db,staff,clientId,{effectiveFrom:'2024-01-01',effectiveTo:'2024-12-31',copyFromPlanId:null})
 plan=await saveCarePlanNeeds(db,staff,plan.id,plan.lockVersion,[{need:'外出を続けたい',longGoal:{goal:'在宅生活'},shortGoals:[{goal:'安全に外出',services:[{content:'架空訪問介護',provider:'架空事業所',kind:'訪問介護',insured:true}]}]}])
 plan=await saveCarePlanSchedule(db,staff,plan.id,plan.lockVersion,[{serviceId:plan.needs[0].shortGoals[0].services[0].id,scheduleType:'weekly',weekday:4,start:'09:00',end:'10:00'}])
 const saved=await saveCarePlan(db,staff,plan.id,plan.lockVersion);await confirmCarePlan(db,staff,plan.id,saved.plan.lockVersion);planId=plan.id
 root=await mkdtemp(join(tmpdir(),'care-month-api-'));const storage=new LocalStorage(root)
 const {ensurePdf}=await import('../forms/admin/pdf.ts'),{putFormAssets}=await import('../forms/admin/assets.ts'),{readMeta}=await import('../forms/admin/files.ts')
 const source=await ensurePdf('care_plan_6');assert.ok(source.pdf);await putFormAssets(storage,readMeta('care_plan_6'),source.pdf,{images:false})
 const server=createApiServer({db:async()=>db,verifier:()=>new DevVerifier(),storage:()=>storage,devAuth:true,queue:()=>({async enqueue(){},async enqueueFormImport(){},async enqueueInspection(){}})})
 server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');origin=`http://127.0.0.1:${a.port}`;close=()=>new Promise(resolve=>server.close(()=>resolve()))
})
after(async()=>{if(!url)return;await close();await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();await rm(root,{recursive:true,force:true})})
async function create(month:string) {const path=`/api/clients/${clientId}/care-plan-months`;const p=await call(path+'/preview','POST',{planId,month});assert.equal(p.status,200);const r=await call(path,'POST',{planId,month,confirmationId:p.body.confirmationId,sourceHash:p.body.sourceHash,requestId:randomUUID()});assert.equal(r.status,201);return r.body.month as CareMonthView}
test('第6表: 確定版から生成、予定/実績分離、保存再送、409、保存版の再現と第7表用IF', {skip},async()=>{
 const month=await create('2024-02'),path='/api/care-plan-months/'+month.id
 assert.equal(month.entries.length,5);assert.ok(month.entries.every(e=>e.actual===null));assert.equal(month.revision,0)
 const duplicate=await call(`/api/clients/${clientId}/care-plan-months`,'POST',{planId,month:'2024-02',confirmationId:month.confirmationId,sourceHash:month.sourceHash,requestId:randomUUID()});assert.equal(duplicate.status,200);assert.equal(duplicate.body.month.id,month.id)
 const entries=structuredClone(month.entries);entries[0].plan.start='11:00';entries[0].plan.end='12:00';entries[1].plan.status='cancelled';entries[2].actual={status:'not_provided',date:null,start:null,end:null,endDate:null,note:'本人希望'};entries[3].actual={status:'provided',date:'2024-02-22',start:'09:10',end:'10:10',endDate:'2024-02-22',note:'10分変更'}
 const input={baseVersion:month.lockVersion,requestId:randomUUID(),entries},saved=await call(path,'PUT',input)
 assert.equal(saved.status,200);assert.equal(saved.body.month.revision,1)
 assert.equal((await call(path,'PUT',input)).body.month.revision,1,'保存再送で版を増やさない')
 assert.equal((await call(path,'PUT',{...input,requestId:randomUUID()})).status,409)
 assert.equal((await call(path,'PUT',{...input,entries:[]})).status,409,'同じUUIDで入力を変えない')
 const past=await call(path+'/revisions/1');assert.equal(past.status,200);assert.deepEqual(past.body.month.entries,entries)
 const next=structuredClone(entries);next[0].plan.note='人が追記';next[3].plan.status='deleted'
 const saved2=await call(path,'PUT',{baseVersion:saved.body.month.lockVersion,requestId:randomUUID(),entries:next});assert.equal(saved2.status,200);assert.equal(saved2.body.month.revision,2)
 assert.deepEqual((await call(path+'/revisions/1')).body.month.entries,entries)
 const removal=await call(path,'PUT',{baseVersion:saved2.body.month.lockVersion,requestId:randomUUID(),entries:next.filter(e=>e.id!==next[3].id)});assert.equal(removal.status,400)
 assert.equal((await call(`/api/documents/${month.documentId}/fields`,'PATCH',{changes:[{key:'monthly.details',value:'汎用APIで変更',base:null}]})).status,409)
 assert.equal((await call(`/api/documents/${month.documentId}/save`,'POST',{scope:'document'})).status,409)
 const regen=await call(path+'/preview','POST',{action:'regenerate',baseVersion:saved2.body.month.lockVersion});assert.equal(regen.status,200);assert.deepEqual(regen.body.entries,next)
 const january=await create('2024-01');assert.equal((await call('/api/care-plan-months/'+january.id,'PUT',{baseVersion:january.lockVersion,requestId:randomUUID(),entries:january.entries})).status,200);const copied=await call(path+'/preview','POST',{action:'copy',baseVersion:saved2.body.month.lockVersion,sourceMonthId:january.id});assert.equal(copied.status,200);assert.ok(copied.body.added.every((e:{actual:unknown})=>e.actual===null));assert.deepEqual(copied.body.entries.slice(0,next.length),next);assert.equal(copied.body.added[0].copiedFrom.revision,1);assert.equal(copied.body.added[0].copiedFrom.monthId,january.id)
 const copySaved=await call(path,'PUT',{baseVersion:saved2.body.month.lockVersion,requestId:randomUUID(),entries:copied.body.entries});assert.equal(copySaved.status,200);assert.equal(copySaved.body.month.entries.at(-1).copiedFrom.revision,1)
 const pdf=await call(`/api/documents/${month.documentId}/pdf?rev=1`);assert.equal(pdf.status,200)
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const load=getDocument({data:new Uint8Array(pdf.body)}),d=await load.promise;let printed='';for(let i=1;i<=d.numPages;i++)printed+=(await(await d.getPage(i)).getTextContent()).items.map(t=>'str'in t?t.str:'').join('');await load.destroy();assert.match(printed,/10分変更/);assert.match(printed,/未実施/);assert.ok(!printed.includes('人が追記'))
 await assert.rejects(db.query("UPDATE care_plan_month_versions SET entries='[]' WHERE month_id=$1",[month.id]),{code:'23514'})
 await assert.rejects(db.query("UPDATE care_plan_months SET target_month='2024-03' WHERE id=$1",[month.id]),{code:'23514'})
})
test('第6表: 未ログイン401・他事業所404・不正月400・未確定版を生成しない', {skip},async()=>{
 const path=`/api/clients/${clientId}/care-plan-months`
 assert.equal((await call(path,'GET',undefined,'')).status,401)
 assert.equal((await call(path,'GET',undefined,'Bearer dev:other-months@example.com')).status,404)
 assert.equal((await call(path+'/preview','POST',{planId,month:'2024-13'})).status,400)
 const draft=await createCarePlan(db,staff,clientId,{effectiveFrom:'2024-01-01',effectiveTo:null,copyFromPlanId:null})
 assert.equal((await call(path+'/preview','POST',{planId:draft.id,month:'2024-03'})).status,404)
 const own=await create('2024-03')
 assert.equal((await call('/api/care-plan-months/'+own.id,'GET',undefined,'Bearer dev:other-months@example.com')).status,404)
 assert.equal((await call('/api/care-plan-months/'+own.id+'/revisions/1','GET',undefined,'Bearer dev:other-months@example.com')).status,404)
})
