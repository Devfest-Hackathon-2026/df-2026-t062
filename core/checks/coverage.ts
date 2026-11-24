import type {CheckSet} from './index.ts'
export interface UninspectedGroup { kinds:string[]; reason:'outside_scope'|'missing_document'|'manual_only'; count:number }
export interface InspectionCoverage { total:number;applicable:number;evaluated:number;unjudged:number;uninspected:number;groups:UninspectedGroup[] }
/** 項目番号ごとに一度だけ数える。第5表とモニタリングの共通項目も重複しない。 */
export function inspectionCoverage(set:CheckSet,targetKinds:ReadonlySet<string>,availableKinds:ReadonlySet<string>,levels:ReadonlyMap<string,string|null>=new Map()):InspectionCoverage {
 const target=set.items.filter(i=>i.docs.some(k=>targetKinds.has(k))), rest=set.items.filter(i=>!target.includes(i))
 const groups=new Map<string,UninspectedGroup>()
 for(const item of rest){
  const kinds=[...item.docs].sort(),reason=!kinds.length?'manual_only':kinds.some(k=>availableKinds.has(k))?'outside_scope':'missing_document'
  const key=reason+':'+kinds.join(',');const group=groups.get(key)??{kinds,reason,count:0};group.count++;groups.set(key,group)
 }
 const evaluated=target.filter(i=>levels.get(i.id)!=null).length
 return {total:set.items.length,applicable:target.length,evaluated,unjudged:target.length-evaluated,uninspected:rest.length,groups:[...groups.values()]}
}
