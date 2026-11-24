import {blank,type Doc,type Person,type Relation} from '../../core/diagram/model.ts'
const person=(id:string,name:string,sex:Person['sex']='unknown',household:Person['household']='不明',age?:number):Person=>({id,name,sex,household,age,deceased:false,x:0,y:0})
const relation=(id:string,kind:Relation['kind'],source:string,target:string):Relation=>({id,kind,source,target})
export function fourPersonFamily():Doc {
 const d=blank()
 d.family.people=[person('mother','架空 和子','female','同居',83),{...person('father','架空 太郎','male','別居'),deceased:true},person('son','架空 健','male','同居',52),person('daughter','架空 由美','female','別居',55)]
 d.family.people[0].isSubject=true
 d.family.relations=[relation('marriage','婚姻','father','mother'),...['son','daughter'].flatMap(c=>['father','mother'].map(p=>relation(`${p}-${c}`,'親子',p,c)))]
 return d
}
export function familyFixtures():Record<string,Doc> {
 const four=fourPersonFamily(),single=blank(),unmarried=fourPersonFamily(),remarried=fourPersonFamily(),three=fourPersonFamily()
 single.family.people=[person('parent','架空の親','female','同居'),person('child','架空の子','male','不明')]
 single.family.relations=[relation('single-parent','親子','parent','child')]
 unmarried.family.relations=unmarried.family.relations.filter(r=>r.kind==='親子')
 remarried.family.relations[0].kind='離婚'
 remarried.family.people.push(person('new-partner','架空の再婚相手','male','同居'),person('half-sibling','架空の末子','female','同居'))
 remarried.family.relations.push(relation('remarriage','婚姻','mother','new-partner'),relation('mother-young','親子','mother','half-sibling'),relation('new-young','親子','new-partner','half-sibling'))
 three.family.people.push(person('spouse','架空の配偶者','male','別居'),person('grandchild','架空の孫','female','同居'))
 three.family.relations.push(relation('child-marriage','婚姻','daughter','spouse'),relation('daughter-grandchild','親子','daughter','grandchild'),relation('spouse-grandchild','親子','spouse','grandchild'))
 const partial=fourPersonFamily();partial.family.relations=partial.family.relations.filter(r=>r.id!=='father-daughter')
 const skip=structuredClone(three);skip.family.relations.push(relation('known-grandparent-parent','親子','father','grandchild'))
 const long=structuredClone(remarried);long.family.people[0].name='架空の長い氏名と補足を持つ家族構成図の人物名';long.family.people[2].deceased=null;long.family.people[2].household='不明'
 const multiple=structuredClone(remarried);multiple.family.relations.push(relation('recorded-other-marriage','婚姻','father','new-partner'),relation('historic-marriage','婚姻','father','mother'))
 const unmarriedShared=structuredClone(remarried);unmarriedShared.family.relations=unmarriedShared.family.relations.filter(r=>r.kind==='親子')
 return {four,single,unmarried,remarried,three,partial,skip,long,multiple,unmarriedShared}
}
