import assert from 'node:assert/strict'
import { test } from 'node:test'
import expected from './fixtures/care-fees/expected.json' with {type:'json'}
import { calculateFee, FEE_MASTER, type FeeInput } from '../core/care-fees.ts'
import type { CareMonthSaved } from '../core/care-month-api.ts'
import { verifyFeeWorkbook } from '../db/care-fee-workbook.ts'
const source=(count:number):CareMonthSaved=>({revision:2,savedAt:'2026-11-23T00:00:00Z',month:{id:'month',clientId:'client',planId:'plan',planVersion:1,confirmationId:'confirmation',sourceHash:'hash',month:'2026-06',documentId:'doc',lockVersion:3,revision:2,services:[{id:'s',content:'身体介護1',provider:'架空事業所',serviceKind:'訪問介護',insured:true}],unexpanded:[],entries:Array.from({length:count},(_,i)=>{const date=`2026-06-${String(i+1).padStart(2,'0')}`;return {id:`e${i}`,sourceKey:null,slotId:null,serviceId:'s',content:'身体介護1',provider:'架空事業所',serviceKind:'訪問介護',insured:true,plan:{date,endDate:date,start:'09:00',end:'09:25',status:'scheduled',note:''},actual:{date,endDate:date,start:'09:00',end:'09:25',status:'provided',note:''}}})}})
const input=():FeeInput=>({masterId:FEE_MASTER.id,basis:'planned',region:'other',careLevel:'要介護1',copay:1,scopeConfirmed:true,codes:{s:'111111'},standardMinutes:{s:25}})
test('Excelの数式を再計算し、独立した期待値の端数・負担割合4例と照合する',async()=>{
 for(const c of expected.cases){const s=source(c.count),i={...input(),region:c.region,copay:c.copay as 1|2|3},copy=structuredClone(s)
  const r=await verifyFeeWorkbook(s,i,calculateFee(s,i))
  assert.equal(r.workbookCheck?.status,'matched');assert.equal(r.workbookCheck.outputs.gross,c.gross);assert.equal(r.workbookCheck.outputs.benefit,c.benefit);assert.equal(r.workbookCheck.outputs.patient,c.patient);assert.deepEqual(s,copy)
 }
})
test('予定取消と実績未実施を別々に集計し、入力不足と検証範囲外では金額を作らない',async()=>{
 const s=source(3);s.month.entries[0].plan.status='cancelled';s.month.entries[1].actual={status:'not_provided',date:null,endDate:null,start:null,end:null,note:''}
 for(const basis of ['planned','actual'] as const){const i={...input(),basis},r=await verifyFeeWorkbook(s,i,calculateFee(s,i));assert.equal(r.workbookCheck?.outputs.count,2)}
 s.month.entries[2].actual=null
 for(const patch of [{basis:'actual' as const},{region:null},{copay:null},{scopeConfirmed:false}]){const i={...input(),...patch},r=await verifyFeeWorkbook(s,i,calculateFee(s,i));assert.equal(r.status,'needs_review');assert.equal(r.gross,null);assert.equal(r.workbookCheck,undefined)}
 s.month.month='2026-12';const r=await verifyFeeWorkbook(s,input(),calculateFee(s,input()));assert.equal(r.status,'needs_review');assert.equal(r.workbookCheck,undefined)
})
test('既存算定とExcelが不一致なら反映を拒否し、版と入力の対応を区別する',async()=>{
 const s=source(2),i=input(),r=calculateFee(s,i);assert.equal(r.status,'calculated')
 await assert.rejects(verifyFeeWorkbook(s,i,{...r,gross:9999}),/一致しません/)
 const a=await verifyFeeWorkbook(s,i,r);s.revision=3;s.month.revision=3
 const b=await verifyFeeWorkbook(s,i,calculateFee(s,i));assert.notEqual(a.workbookCheck?.inputHash,b.workbookCheck?.inputHash)
})
