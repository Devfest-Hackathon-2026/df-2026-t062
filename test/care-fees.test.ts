import assert from 'node:assert/strict'
import { test } from 'node:test'
import expected from './fixtures/care-fees/expected.json' with {type:'json'}
import { calculateFee,amountsWithinLimit,FEE_MASTER,type FeeInput } from '../core/care-fees.ts'
import type { CareMonthSaved } from '../core/care-month-api.ts'
const source=(count=1):CareMonthSaved=>({revision:1,savedAt:'2026-11-22T00:00:00Z',month:{id:'month1',clientId:'client1',planId:'plan1',planVersion:1,confirmationId:'confirmation1',sourceHash:'source-hash',month:'2026-06',documentId:'document6',lockVersion:2,revision:1,services:[{id:'s1',content:'身体介護',provider:'架空事業所',serviceKind:'訪問介護',insured:true}],unexpanded:[],entries:Array.from({length:count},(_,i)=>{const date='2026-06-'+String(i+1).padStart(2,'0');return {id:'e'+i,sourceKey:null,serviceId:'s1',slotId:null,content:'身体介護',provider:'架空事業所',serviceKind:'訪問介護',insured:true,plan:{date,start:'09:00',end:'09:25',endDate:date,status:'scheduled',note:''},actual:{date,start:'09:00',end:'09:15',endDate:date,status:'provided',note:'標準所要時間とは別の実測時間'}}})}})
const input=():FeeInput=>({masterId:FEE_MASTER.id,basis:'planned',region:'other',careLevel:'要介護1',copay:1,scopeConfirmed:true,codes:{s1:'111111'},standardMinutes:{s1:25}})
test('第7表: 一次資料の単位/単価/給付式から先に決めた4件の期待値と一致する',()=>{
 for(const c of expected.cases){const r=calculateFee(source(c.count),{...input(),region:c.region,copay:c.copay as 1|2|3});assert.equal(r.status,'calculated');assert.deepEqual({units:r.units,gross:r.gross,benefit:r.benefit,patient:r.patient},{units:c.units,gross:c.gross,benefit:c.benefit,patient:c.patient});assert.equal(r.remaining,16765-c.units)}
})
test('県の歴史的な端数例は式だけ検証し、現行コード244単位へ古い245単位を混ぜない',()=>{
 const c=expected.roundingOnly;assert.deepEqual(amountsWithinLimit(c.units,c.priceHundredths,c.copay),{gross:c.gross,benefit:c.benefit,patient:c.patient});assert.equal(FEE_MASTER.codes['111111'].units,244)
})
test('実績と予定を区別し、実測時間から標準所要時間やサービスコードを生成しない',()=>{
 const s=source(3);s.month.entries[0].plan.status='cancelled';s.month.entries[1].actual={status:'not_provided',date:null,start:null,end:null,endDate:null,note:'本人希望'}
 assert.equal(calculateFee(s,input()).count,2)
 const actual=calculateFee(s,{...input(),basis:'actual'});assert.equal(actual.count,2);assert.equal(actual.units,488,'実測15分でも標準25分のコードを人が確認した244単位を使う')
 s.month.entries[2].actual=null;const missing=calculateFee(s,{...input(),basis:'actual'});assert.equal(missing.status,'needs_review');assert.equal(missing.gross,null);assert.ok(missing.reasons.includes('actual_missing'))
})
test('未知コード/級地/負担/標準時間/確認不足/制度適用月外を未計算にし、不明を0にしない',()=>{
 for(const patch of [{codes:{s1:'UNKNOWN'}},{region:'不明'},{region:'__proto__'},{careLevel:'constructor'},{copay:null},{standardMinutes:{}},{scopeConfirmed:false},{careLevel:'要支援1'},{masterId:'future-master'}]){
 const r=calculateFee(source(),{...input(),...patch});assert.equal(r.status,'needs_review');assert.equal(r.units,null);assert.equal(r.gross,null);assert.equal(r.patient,null)
 }
 for(const month of ['2026-05','2026-12']){const s=source();s.month.month=month;const r=calculateFee(s,input());assert.equal(r.status,'needs_review');assert.ok(r.reasons.includes('master_period'))}
})
test('複数回/他サービス/未展開/跨日/夜間/保険外は限定範囲外。元の保存版を変更しない',()=>{
 const cases=[source(2),source(),source(),source(),source(),source()]
 cases[0].month.entries[1].plan.date=cases[0].month.entries[0].plan.date
 cases[0].month.entries[1].plan.endDate=cases[0].month.entries[0].plan.date
 cases[1].month.services.push({...cases[1].month.services[0],id:'s2'})
 cases[2].month.unexpanded.push({serviceId:'s1',slotId:'other',note:'時期未確定'})
 cases[3].month.entries[0].plan.endDate='2026-06-02'
 cases[4].month.entries[0].plan.start='07:00'
 cases[5].month.entries[0].insured=false
 for(const s of cases){const copy=structuredClone(s),r=calculateFee(s,input());assert.equal(r.status,'needs_review');assert.equal(r.benefit,null);assert.deepEqual(s,copy)}
 const s=source();s.revision=0;assert.equal(calculateFee(s,input()).status,'needs_review')
})

test('第6表で追加入力した介護区分や限度額の矛盾、福祉用具は限定算定へ流さない',()=>{
 const s=source();s.month.headers={insurerNumber:'',insurerName:'',insuredNumber:'',submittedDate:'',careLevel:'要介護2'}
 let r=calculateFee(s,input());assert.equal(r.status,'needs_review');assert.equal(r.gross,null);assert.ok(r.reasons.includes('source_header_mismatch'))
 s.month.headers={...s.month.headers,careLevel:'要介護1',limitUnits:'12345'}
 assert.ok(calculateFee(s,input()).reasons.includes('source_header_mismatch'))
 s.month.headers={...s.month.headers,limitUnits:'16765'}
 assert.equal(calculateFee(s,input()).status,'calculated')
 s.month.entries[0].taisCode='000000-000000'
 r=calculateFee(s,input());assert.equal(r.status,'needs_review');assert.equal(r.gross,null);assert.ok(r.reasons.includes('code_unsupported'))
})
