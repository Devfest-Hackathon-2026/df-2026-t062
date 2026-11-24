import type { Doc, Person, Relation } from './model.ts'
export const livesInHousehold = (person: Person) => person.deceased !== true && person.household === '同居'
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const lineHeight = 24
export function familyLabels(person: Person) {
  const chars = Array.from(`${person.name || '名前未確認'}${person.age == null ? '' : `（${person.age}歳）`}`)
  const names = Array.from({length: Math.ceil(chars.length / 12)}, (_, i) => chars.slice(i * 12, (i + 1) * 12).join(''))
  const household = person.deceased === true ? '' : person.household === '不明' ? '同居未確認' : person.household === '別居' ? '別居' : ''
  const life = person.deceased === null ? '生死未確認' : person.deceased ? '' : '生存'
  return { names, status: [person.isSubject ? '本人' : '', household, life].filter(Boolean).join('・') }
}
export function familyPersonBounds(person: Person) {
  const {names,status} = familyLabels(person)
  const half = Math.max(70, ...names.map(n => Array.from(n).length * 10), Array.from(status).length * 7)
  return {left: person.x + 60 - half, right: person.x + 60 + half, top: person.y + 4, bottom: person.y + 121 + (names.length - 1) * lineHeight}
}
const orderedRelations = (relations: Relation[], ids: Set<string>) => [...relations].filter(r => ids.has(r.source) && ids.has(r.target) && r.source !== r.target).sort((a,b) => compare(a.id,b.id))
export interface ParentGroup { parents: string[]; children: string[]; relationIds: string[] }
/** 同じ明示された親集合だけをまとめる。配偶者がいても、登録のない親子関係は足さない。 */
export function familyParentGroups(people: Person[], relations: Relation[]): ParentGroup[] {
  const edges = orderedRelations(relations,new Set(people.map(p=>p.id))).filter(r=>r.kind==='親子')
  const parents = new Map<string,string[]>()
  for (const r of edges) parents.set(r.target,[...new Set([...(parents.get(r.target)??[]),r.source])].sort(compare))
  const groups = new Map<string,ParentGroup>()
  for (const child of [...parents.keys()].sort(compare)) {
    const ps=parents.get(child)!, key=JSON.stringify(ps), group=groups.get(key)??{parents:ps,children:[],relationIds:[]}
    group.children.push(child);group.relationIds.push(...edges.filter(r=>r.target===child).map(r=>r.id));groups.set(key,group)
  }
  return [...groups].sort(([a],[b])=>compare(a,b)).map(([,g])=>({...g,relationIds:g.relationIds.sort(compare)}))
}

/** 関係を優先した世代配置。同居の状態や入力座標では人物を離さない。 */
export function familyLayout(family: Doc['family']): Person[] {
  const people=[...family.people].sort((a,b)=>compare(a.id,b.id)), ids=new Set(people.map(p=>p.id))
  const relations=orderedRelations(family.relations,ids), parents=relations.filter(r=>r.kind==='親子')
  const groups=new Map(people.map(p=>[p.id,p.id]))
  const root=(id:string):string=>groups.get(id)===id?id:root(groups.get(id)!)
  const reach=(from:string,to:string,seen=new Set<string>()):boolean=>{
    if(from===to)return true
    if(seen.has(from))return false
    seen.add(from)
    return parents.filter(r=>root(r.source)===from&&root(r.target)!==from).some(r=>reach(root(r.target),to,seen))
  }
  // 世代を循環させる配偶関係は同じ段へ圧縮せず、経路側で長い線として扱う。
  for(const r of relations.filter(r=>r.kind!=='親子')) {
    const a=root(r.source),b=root(r.target)
    if(a!==b&&!reach(a,b)&&!reach(b,a))groups.set(compare(a,b)<0?b:a,compare(a,b)<0?a:b)
  }
  const levels=new Map<string,number>()
  const level=(id:string):number=>{
    const key=root(id);if(levels.has(key))return levels.get(key)!
    const ancestors=parents.filter(r=>root(r.target)===key&&root(r.source)!==key)
    const n=Math.max(0,...ancestors.map(r=>level(r.source)+1));levels.set(key,n);return n
  }
  const rowOf=new Map(people.map(p=>[p.id,level(p.id)])), placed=new Map<string,Person>()
  const step=Math.max(200,...people.map(p=>{const b=familyPersonBounds(p);return b.right-b.left+72}))
  const parentGroups=familyParentGroups(people,relations)
  let y=70
  for(let row=0;row<=Math.max(0,...rowOf.values());row++) {
    const units=new Map<string,Person[]>()
    for(const p of people.filter(p=>rowOf.get(p.id)===row))units.set(root(p.id),[...(units.get(root(p.id))??[]),p])
    const blocks=[...units].map(([key,members])=>{
      const remaining=new Set(members.map(p=>p.id)), sequence:Person[]=[]
      const neighbors=(id:string)=>relations.filter(r=>r.kind!=='親子'&&(r.source===id||r.target===id)).map(r=>r.source===id?r.target:r.source).filter(id=>remaining.has(id))
      while(remaining.size) {
        let id=[...remaining].sort((a,b)=>neighbors(a).length-neighbors(b).length||compare(a,b))[0]
        while(remaining.has(id)) {sequence.push(members.find(p=>p.id===id)!);remaining.delete(id);id=neighbors(id).sort(compare)[0]}
      }
      const anchors=parents.filter(r=>members.some(p=>p.id===r.target)).flatMap(r=>placed.has(r.source)?[placed.get(r.source)!.x+60]:[])
      return {key,members:sequence,wanted:anchors.length?anchors.reduce((a,b)=>a+b,0)/anchors.length:undefined}
    }).sort((a,b)=>(a.wanted??0)-(b.wanted??0)||compare(a.key,b.key))
    let end=-Infinity
    const centers=blocks.map((b,i)=>{
      const width=b.members.length*step, desired=b.wanted??(60+step*i+(width-step)/2)
      const center=Math.max(desired,end+width/2);end=center+width/2
      return {b,width,center,desired}
    })
    const correction=centers.length?centers.reduce((n,c)=>n+c.desired-c.center,0)/centers.length:0
    const left=centers.length?Math.min(...centers.map(c=>c.center+correction-c.width/2)):0
    const shift=correction+Math.max(0,30-left)
    for(const c of centers)c.b.members.forEach((p,i)=>placed.set(p.id,{...p,x:c.center+shift-c.width/2+step*(i+.5)-60,y}))
    const bottom=Math.max(y+120,...people.filter(p=>placed.has(p.id)&&rowOf.get(p.id)===row).map(p=>familyPersonBounds(placed.get(p.id)!).bottom))
    const incoming=parentGroups.filter(g=>g.children.some(id=>rowOf.get(id)===row+1)).length
    const partners=relations.filter(r=>r.kind!=='親子'&&(rowOf.get(r.source)===row+1||rowOf.get(r.target)===row+1)).length
    y=bottom+100+(incoming+partners)*14
  }
  return people.map(p=>placed.get(p.id)!)
}

export interface RelationPath {
  path: string
  kind: 'partner'|'parent'
  relationIds: string[]
  parents?: string[]
  children?: string[]
  divorceMark?: {x:number;y:number}
  unionJunction?: {x:number;y:number}
}
const polyline=(points:{x:number;y:number}[])=>points.map((p,i)=>i===0?`M${p.x} ${p.y}`:p.x===points[i-1].x?(p.y===points[i-1].y?'':`V${p.y}`):`H${p.x}`).filter(Boolean).join(' ')
/** 家族単位の幹線・兄弟線。各子が持つ明示された親集合が一致するときだけ共有する。 */
export function familyRelationPaths(people: Person[], relations: Relation[], right: number) {
  const positions=new Map(people.map(p=>[p.id,p])), edges=orderedRelations(relations,new Set(positions.keys()))
  const paths:RelationPath[]=[], unions=new Map<string,{x:number;y:number;direct:boolean}>()
  const pairKey=(ids:string[])=>JSON.stringify([...ids].sort(compare))
  let rail=right
  const topLanes=new Map<number,number>()
  const rows=[...new Set(people.map(p=>p.y))].sort((a,b)=>a-b)
  const partners=new Map<string,Relation[]>()
  for(const r of edges.filter(r=>r.kind!=='親子')) {const key=pairKey([r.source,r.target]);partners.set(key,[...(partners.get(key)??[]),r])}
  for(const records of partners.values()) {
    const r=records[0]
    const [a,b]=[positions.get(r.source)!,positions.get(r.target)!].sort((a,b)=>a.x-b.x||compare(a.id,b.id))
    const cy=a.y+32, direct=a.y===b.y&&!people.some(p=>p.id!==a.id&&p.id!==b.id&&p.y===a.y&&p.x>a.x&&p.x<b.x)
    let points:{x:number;y:number}[], mark:{x:number;y:number}
    if(direct){points=[{x:a.x+88,y:cy},{x:b.x+32,y:cy}];mark={x:(a.x+b.x)/2+60,y:cy}}
    else {
      const lane=Math.max(topLanes.get(a.y)??0,topLanes.get(b.y)??0)+1
      topLanes.set(a.y,lane);topLanes.set(b.y,lane);rail+=14
      const ya=a.y-28-lane*14,yb=b.y-28-lane*14
      points=[{x:a.x+60,y:a.y+4},{x:a.x+60,y:ya},{x:rail,y:ya},{x:rail,y:yb},{x:b.x+60,y:yb},{x:b.x+60,y:b.y+4}]
      mark={x:(a.x+60+rail)/2,y:ya}
    }
    paths.push({path:polyline(points),kind:'partner',relationIds:records.map(r=>r.id),divorceMark:records.some(r=>r.kind==='離婚')?mark:undefined})
    // 複数の婚姻/離婚記録があっても、親の集合は変えない。
    unions.set(pairKey([a.id,b.id]),{...mark,direct})
  }
  const lanes=new Map<number,number>(), ports=new Map<string,number>()
  const parentalGroups=familyParentGroups(people,relations)
  for(const group of parentalGroups) {
    const ps=group.parents.map(id=>positions.get(id)!), cs=group.children.map(id=>positions.get(id)!).sort((a,b)=>a.x-b.x)
    // 複数世代にまたがる親子は世代ごとに分け、途中の人物を横断しない外側経路を使う。
    for(const childY of [...new Set(cs.map(p=>p.y))].sort((a,b)=>a-b)) {
      const children=cs.filter(p=>p.y===childY), lane=lanes.get(childY)??0;lanes.set(childY,lane+1)
      const busY=childY-28-lane*14
      const adjacent=ps.every(p=>rows[rows.indexOf(p.y)+1]===childY)
      const union=ps.length===2?unions.get(pairKey(group.parents)):undefined
      let anchor:number, startY:number, parts:string[]=[]
      if(adjacent&&union?.direct) {anchor=union.x;startY=union.y}
      else {
        anchor=adjacent?Math.max(...ps.map(p=>familyPersonBounds(p).right))+44:(rail+=18)
        const exit=(p:Person)=>familyPersonBounds(p).bottom+42+lane*14
        startY=adjacent?Math.max(...ps.map(exit)):Math.min(...ps.map(exit))
        for(const p of ps) {
          const use=ports.get(p.id)??0;ports.set(p.id,use+1)
          const total=parentalGroups.reduce((n,g)=>n+(g.parents.includes(p.id)?new Set(g.children.map(id=>positions.get(id)!.y)).size:0),0)
          const left=total>1&&use%2===0,offset=total>1?-12+24*(use+1)/(total+1):0
          const bounds=familyPersonBounds(p), side=left?bounds.left-30:bounds.right+30,joinY=adjacent?startY:exit(p)
          const edge=p.sex==='unknown'?28-Math.abs(offset):p.sex==='male'?27:Math.sqrt(27**2-offset**2)
          parts.push(polyline([{x:p.x+60+(left?-1:1)*(edge+1),y:p.y+32+offset},{x:side,y:p.y+32+offset},{x:side,y:joinY},{x:anchor,y:joinY}]))
        }
      }
      parts.push(polyline([{x:anchor,y:startY},{x:anchor,y:busY}]))
      const xs=[anchor,...children.map(p=>p.x+60)]
      parts.push(polyline([{x:Math.min(...xs),y:busY},{x:Math.max(...xs),y:busY}]))
      for(const p of children)parts.push(polyline([{x:p.x+60,y:busY},{x:p.x+60,y:p.y+4}]))
      const childIds=children.map(p=>p.id).sort(compare)
      paths.push({path:parts.join(' '),kind:'parent',unionJunction:adjacent&&union?.direct?{x:union.x,y:union.y}:undefined,parents:group.parents,children:childIds,relationIds:group.relationIds.filter(id=>edges.some(r=>r.id===id&&childIds.includes(r.target)))})
    }
  }
  return {paths,right:rail}
}

/** 同居者の連続した範囲を段ごとに囲む。別居・不明・死亡者を囲みに混ぜない。 */
export function familyHouseholds(people:Person[]) {
  const boxes:{x:number;y:number;width:number;height:number;people:string[]}[]=[]
  for(const y of [...new Set(people.map(p=>p.y))].sort((a,b)=>a-b)) {
    let run:Person[]=[]
    const finish=()=>{if(!run.length)return;const bs=run.map(familyPersonBounds),x=Math.min(...bs.map(b=>b.left))-18,top=Math.min(...bs.map(b=>b.top))-18;boxes.push({x,y:top,width:Math.max(...bs.map(b=>b.right))+18-x,height:Math.max(...bs.map(b=>b.bottom))+18-top,people:run.map(p=>p.id)});run=[]}
    for(const p of people.filter(p=>p.y===y).sort((a,b)=>a.x-b.x)){if(livesInHousehold(p))run.push(p);else finish()}
    finish()
  }
  return boxes
}
