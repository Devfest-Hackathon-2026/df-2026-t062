import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPool } from '../db/pool.ts'
import { migrate } from '../db/migrate.ts'
import { seed } from '../db/seed.ts'
import { registerVersion, versionForOffice, FormNotFound } from '../db/forms.ts'
import { readSeed } from '../forms/admin/files.ts'
import { createCareRecord } from '../db/care-records.ts'
import { createCarePlan, saveCarePlanNeeds, saveCarePlanSchedule, saveCarePlan, confirmCarePlan } from '../db/care-plans.ts'
import { createCareMonth, previewCareMonth, saveCareMonth, getCareMonth } from '../db/care-months.ts'
import { calculateCareFee } from '../db/care-fees.ts'
import { FEE_MASTER } from '../core/care-fees.ts'

test('第4〜7表は事業所の公開様式を新規書類だけに採用し、旧版を保持。不適合な第6表の保存は原子的に拒否する', {skip:!process.env.DATABASE_URL},async()=>{
 const url=process.env.DATABASE_URL!,schema=`t_care_office_forms_${process.pid}`
 const admin=await createPool({DATABASE_URL:url});await admin.query(`CREATE SCHEMA ${schema}`);await admin.end()
 const db=await createPool({DATABASE_URL:url,DB_SCHEMA:schema})
 try{
  await migrate(db)
  const {staff,clients}=await seed(db,{email:'office-forms@example.com'}),clientId=clients.sato
  const other=await seed(db,{email:'other-office-forms@example.com',officeName:'別事業所'})
  let plan=await createCarePlan(db,staff,clientId,{effectiveFrom:'2026-06-01',effectiveTo:'2026-11-30',copyFromPlanId:null})
  plan=await saveCarePlanNeeds(db,staff,plan.id,plan.lockVersion,[{need:'在宅生活を続ける',longGoal:{goal:'自宅で暮らす'},shortGoals:[{goal:'支援を受ける',services:[{content:'架空の身体介護',kind:'訪問介護',provider:'架空事業所',insured:true}]}]}])
  const serviceId=plan.needs[0].shortGoals[0].services[0].id
  plan=await saveCarePlanSchedule(db,staff,plan.id,plan.lockVersion,[{serviceId,scheduleType:'weekly',weekday:1,start:'09:00',end:'09:25'}])
  const saved=await saveCarePlan(db,staff,plan.id,plan.lockVersion);await confirmCarePlan(db,staff,plan.id,saved.plan.lockVersion)
  const createMonth=async(month:string,save=true)=>{
   const preview=await previewCareMonth(db,staff.officeId,clientId,plan.id,month)
   const r=await createCareMonth(db,staff,clientId,{planId:plan.id,month,confirmationId:preview.confirmationId,sourceHash:preview.sourceHash,requestId:randomUUID()})
   return save?await saveCareMonth(db,staff,r.month.id,{requestId:randomUUID(),baseVersion:r.month.lockVersion,entries:r.month.entries}):r.month
  }
  const fee=async(month:Awaited<ReturnType<typeof getCareMonth>>)=>calculateCareFee(db,staff,month.id,{requestId:randomUUID(),sourceRevision:month.revision,baseRevision:0,masterId:FEE_MASTER.id,basis:'planned',region:'other',careLevel:'要介護1',copay:1,scopeConfirmed:true,codes:{[serviceId]:'111111'},standardMinutes:{[serviceId]:25}})
  const version=async(id:string)=>String((await db.query('SELECT template_version_id FROM documents WHERE id=$1',[id])).rows[0].template_version_id)
  const global4=await createCareRecord(db,staff,clientId,{kind:'care_plan_4',requestId:randomUUID()}),global5=await createCareRecord(db,staff,clientId,{kind:'care_plan_5',requestId:randomUUID()})
  const june=await createMonth('2026-06'),global7=await fee(june)
  const oldIds=[global4.id,global5.id,june.documentId,global7.documentId],oldVersions=await Promise.all(oldIds.map(version))
  const kinds=['care_plan_4','care_plan_5','care_plan_6','care_plan_7'] as const
  const own=await Promise.all(kinds.map(kind=>registerVersion(db,{...readSeed(kind),officeId:staff.officeId,name:`事業所の${kind}`},{publish:true})))
  const own4=await createCareRecord(db,staff,clientId,{kind:'care_plan_4',requestId:randomUUID()}),own5=await createCareRecord(db,staff,clientId,{kind:'care_plan_5',requestId:randomUUID()})
  const july=await createMonth('2026-07'),own7=await fee(july)
  assert.deepEqual(await Promise.all([own4.id,own5.id,july.documentId,own7.documentId].map(version)),own.map(v=>v.versionId))
  assert.deepEqual(await Promise.all(oldIds.map(version)),oldVersions)
  for(const v of own)await assert.rejects(versionForOffice(db,other.staff.officeId,v.versionId),FormNotFound)
  const changed=readSeed('care_plan_6')
  const v2=await registerVersion(db,{...changed,officeId:staff.officeId,name:'事業所の第6表・改定',pages:changed.pages.map(p=>({...p,title:p.title+'（改定）'}))},{publish:true})
  const august=await createMonth('2026-08');assert.equal(await version(august.documentId),v2.versionId);assert.equal(await version(july.documentId),own[2].versionId)
  await registerVersion(db,{...readSeed('care_plan_5'),kind:'care_plan_6',officeId:staff.officeId,name:'月次の必須欄を持たない様式'},{publish:true})
  const september=await createMonth('2026-09',false)
  await assert.rejects(saveCareMonth(db,staff,september.id,{requestId:randomUUID(),baseVersion:september.lockVersion,entries:september.entries}),/様式/)
  const untouched=await getCareMonth(db,staff.officeId,september.id);assert.equal(untouched.revision,0);assert.equal(untouched.lockVersion,september.lockVersion);assert.deepEqual(untouched.entries,september.entries)
  assert.deepEqual(await Promise.all(oldIds.map(version)),oldVersions)
 }finally{await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end()}
})
