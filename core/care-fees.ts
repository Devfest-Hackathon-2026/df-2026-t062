import { z } from 'zod'
import master from './fee-masters/2026-06-basic.json' with {type:'json'}
import type { CareMonthSaved } from './care-month-api.ts'
import { TargetMonth } from './care-month.ts'
function freeze<T>(value:T):Readonly<T> { if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value)}return value }
export const FEE_MASTER=freeze(master)
export const FeeInputSchema=z.object({masterId:z.string().max(100),basis:z.enum(['planned','actual']),region:z.string().max(30).nullable().default(null),careLevel:z.string().max(30).nullable().default(null),copay:z.union([z.literal(1),z.literal(2),z.literal(3)]).nullable().default(null),scopeConfirmed:z.boolean().default(false),codes:z.record(z.string().max(100),z.string().max(30)).default({}),standardMinutes:z.record(z.string().max(100),z.number().int().min(0).max(1440)).default({})}).strict()
export type FeeInput=z.infer<typeof FeeInputSchema>
export const FEE_REASONS={
 source_unsaved:'保存済み第6表の特定版が必要です。',source_period:'第6表の日時と対象月が一致しません。',master_unknown:'選択されたマスターは未検証です。',master_period:'この対象月はマスターの検証範囲外です。',scope_unconfirmed:'加減算・公費・他の月間サービス・認定変更等がない限定条件を確認してください。',region_missing:'事業所の地域区分を確認してください。',care_level:'要介護1〜5の確認が必要です。',copay_missing:'負担割合を確認してください。',code_unsupported:'未選択または未対応のサービスコードです。',standard_time:'訪問介護計画の標準所要時間20分以上30分未満を確認してください。',actual_missing:'実績未入力があります。取消や削除から未実施とは推測しません。',multiple_services:'複数サービス・事業所の算定は未対応です。',unexpanded:'日付が未確定の週単位以外の予定があります。',multiple_visits:'同日に複数回の訪問があり、合算・例外判定は未対応です。',time_premium:'夜間・早朝・跨日等の条件は未対応です。',uninsured:'保険外サービスはこの計算の対象外です。',provider_missing:'提供事業所を確認してください。',kind_mismatch:'確認済みの訪問介護サービス・事業所と一致しません。',no_entries:'算定対象の記録がありません。',limit_exceeded:'限度超過の配分・金額は未検証のため計算しません。',
} as const
export type FeeReason=keyof typeof FEE_REASONS
export interface FeeAmounts {gross:number;benefit:number;patient:number}
export interface FeeWorkbookCheck { templateId:string;templateHash:string;inputHash:string;engine:string;status:'matched';outputs:Record<string,number> }
interface FeeContext {masterId:string;basis:FeeInput['basis'];reasons:FeeReason[];entryIds:string[];workbookCheck?:FeeWorkbookCheck}
export type FeeResult=(FeeContext&{status:'needs_review';count:null;units:null;limit:null;remaining:null;priceHundredths:null;gross:null;benefit:null;patient:null})|(FeeContext&FeeAmounts&{status:'calculated';count:number;units:number;limit:number;remaining:number;priceHundredths:number})
/** Integer arithmetic follows the two floor operations; not per-visit rounded payments. */
export function amountsWithinLimit(units:number,priceHundredths:number,copay:number):FeeAmounts {
 if(!Number.isSafeInteger(units)||units<0||!Number.isSafeInteger(priceHundredths)||priceHundredths<=0||![1,2,3].includes(copay))throw new Error('算定の数値が不正です')
 const gross=BigInt(units)*BigInt(priceHundredths)/100n,benefit=gross*BigInt(100-10*copay)/100n
 if(gross>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('算定の範囲を超えています')
 return {gross:Number(gross),benefit:Number(benefit),patient:Number(gross-benefit)}
}
/** No network, AI, clock or writes. Conditions not proven by this scope return null amounts. */
export function calculateFee(source:CareMonthSaved,input:FeeInput):FeeResult {
 const reasons=new Set<FeeReason>(),month=source.month
 const add=(condition:boolean,reason:FeeReason)=>{if(condition)reasons.add(reason)}
 add(source.revision<1||month.revision!==source.revision,'source_unsaved')
 add(!TargetMonth.safeParse(month.month).success,'source_period')
 add(input.masterId!==FEE_MASTER.id,'master_unknown')
 add(month.month<FEE_MASTER.effectiveFrom||month.month>FEE_MASTER.verifiedThrough,'master_period')
 add(!input.scopeConfirmed,'scope_unconfirmed')
 const price=input.region&&Object.hasOwn(FEE_MASTER.priceHundredths,input.region)?(FEE_MASTER.priceHundredths as Record<string,number>)[input.region]:undefined
 const limit=input.careLevel&&Object.hasOwn(FEE_MASTER.limits,input.careLevel)?(FEE_MASTER.limits as Record<string,number>)[input.careLevel]:undefined
 add(!price,'region_missing');add(!limit,'care_level');add(!input.copay,'copay_missing')
 add(month.services.length!==1,'multiple_services');add(month.unexpanded.length>0,'unexpanded')
 if(input.basis==='actual')add(month.entries.some(e=>e.actual===null),'actual_missing')
 const entries=month.entries.filter(e=>input.basis==='planned'?e.plan.status==='scheduled':e.actual?.status==='provided')
 add(!entries.length,'no_entries');add(new Set(entries.map(e=>e.serviceId)).size>1,'multiple_services')
 const days=new Set<string>()
 for(const e of entries){
  const visit=input.basis==='planned'?e.plan:e.actual
  if(!visit||visit.status==='not_provided')continue
  add(!visit.date?.startsWith(month.month+'-'),'source_period')
  add(visit.endDate!==visit.date||visit.start!<'08:00'||visit.end!>'18:00'||visit.end!<=visit.start!,'time_premium')
  add(days.has(visit.date!),'multiple_visits');days.add(visit.date!)
  add(input.codes[e.serviceId]!=='111111','code_unsupported')
  const minutes=input.standardMinutes[e.serviceId]
  add(!Number.isInteger(minutes)||minutes<20||minutes>=30,'standard_time')
  add(!e.insured,'uninsured');add(!e.provider?.trim(),'provider_missing')
  const service=month.services.find(s=>s.id===e.serviceId)
  add(!service,'multiple_services')
  add(e.serviceKind!=='訪問介護'||service?.serviceKind!=='訪問介護'||e.provider!==service?.provider,'kind_mismatch')
 }
 const units=entries.length*FEE_MASTER.codes['111111'].units
 add(!!limit&&units>limit,'limit_exceeded')
 const context={masterId:input.masterId,basis:input.basis,reasons:[...reasons],entryIds:entries.map(e=>e.id)}
 if(reasons.size)return {...context,status:'needs_review',count:null,units:null,limit:null,remaining:null,priceHundredths:null,gross:null,benefit:null,patient:null}
 return {...context,status:'calculated',count:entries.length,units,limit:limit!,remaining:limit!-units,priceHundredths:price!,...amountsWithinLimit(units,price!,input.copay!)}
}
