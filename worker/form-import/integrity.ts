// #214: 印字の文字に基づく位置補正と、元号の排他的な対応。AI・利用者データは使わない。
import { specOf } from '../../core/binding.ts'
import { parseRef } from './version.ts'
import type { DraftSlot, LocalField } from './draft.ts'
import type { LayoutPage, LayoutWord } from './pdf.ts'
const normalize=(s:string)=>s.normalize('NFKC').replace(/\s/g,'')
const round=(n:number)=>Math.round(n*100)/100
const ERA=[['M','明','明治'],['T','大','大正'],['S','昭','昭和'],['H','平','平成'],['R','令','令和']] as const
const era=(s:string|undefined)=>ERA.find(row=>row.some(v=>v===normalize(s??'')))

/** PDFの文字の送り幅を使う。語にまとめられた文字列を等分して位置を推測しない。 */
function spans(page:Pick<LayoutPage,'words'|'chars'>,target:string):LayoutWord[] {
 const found=page.words.filter(w=>normalize(w.t)===target)
 const lines:{y:number;chars:LayoutPage['chars']}[]=[]
 for(const c of [...page.chars].sort((a,b)=>a.y0-b.y0||a.x0-b.x0)){
  let line=lines.find(l=>Math.abs(l.y-c.y0)<1)
  if(!line){line={y:c.y0,chars:[]};lines.push(line)}
  line.chars.push(c)
 }
 for(const line of lines){
  const cs=line.chars.sort((a,b)=>a.x0-b.x0), text=cs.map(c=>normalize(c.t)).join('')
  let at=0
  for(let start=text.indexOf(target);start>=0;start=text.indexOf(target,start+1)){
   at=0;const chosen:LayoutPage['chars']=[];let first=-1,last=-1
   for(let i=0;i<cs.length;i++){
    const end=at+normalize(cs[i].t).length
    if(at===start)first=i
    if(end===start+target.length)last=i
    if(at>=start&&end<=start+target.length)chosen.push(cs[i])
    at=end
   }
   if(first<0||last<first||!chosen.length)continue
   if(/[A-Za-z0-9]$/.test(target)&&/^[A-Za-z0-9]/.test(normalize(cs[last+1]?.t??'')))continue
   if(/^[A-Za-z0-9]/.test(target)&&/[A-Za-z0-9]$/.test(normalize(cs[first-1]?.t??'')))continue
   if(chosen.some((c,i)=>i>0&&c.x0-chosen[i-1].x1>2))continue
   found.push({t:target,x0:Math.min(...chosen.map(c=>c.x0)),y0:Math.min(...chosen.map(c=>c.y0)),x1:Math.max(...chosen.map(c=>c.x1)),y1:Math.max(...chosen.map(c=>c.y1))})
  }
 }
 return [...new Map(found.map(w=>[[w.x0,w.y0,w.x1,w.y1].map(round).join(','),w])).values()]
}
export function correctPrintedGeometry(slots:DraftSlot[],page:Pick<LayoutPage,'words'|'chars'>):DraftSlot[] {
 return slots.map(s=>{
  if(s.ui==='circle'&&s.box===undefined){
   const target=normalize(s.mark?.kind==='eq'?s.mark.value:s.label)
   if(!target)return s
   const cx=s.x+s.w/2,cy=s.y+s.h/2
   const candidates=spans(page,target).map(w=>({w,d:Math.abs((w.x0+w.x1)/2-cx)+2*Math.abs((w.y0+w.y1)/2-cy)}))
    .filter(({w})=>Math.abs((w.y0+w.y1)/2-cy)<=4&&Math.abs((w.x0+w.x1)/2-cx)<=15).sort((a,b)=>a.d-b.d)
   if(!candidates.length||candidates[1]&&candidates[1].d-candidates[0].d<1)return s
   const w=candidates[0].w
   return {...s,x:round(w.x0-.4),y:round(w.y0-.4),w:round(w.x1-w.x0+.8),h:round(w.y1-w.y0+.8)}
  }
  if(s.ui!=='text'&&s.ui!=='area')return s
  const prefix=page.words.filter(w=>/^(?:tel[.:：]?|fax[.:：]?|電話(?:番号)?[:：]?)$/i.test(w.t.trim())&&w.x0>=s.x-1&&w.x0<=s.x+s.w*.5&&w.y0>=s.y-1&&w.y0<=s.y+3&&w.y1>s.y)
  const x=prefix.length?Math.max(s.x,...prefix.map(w=>w.x1+.8)):s.x
  return x>s.x&&s.x+s.w-x>=3?{...s,x:round(x),w:round(s.x+s.w-x)}:s
 })
}

/** 日付欄が一意のときだけその元号にする。不明なら独立boolではなく同じenumを共有する。 */
export function normalizeEraChoices(slots:DraftSlot[],fields:LocalField[],page=1):{slots:DraftSlot[];fields:LocalField[]} {
 const next=slots.map(s=>({...s})), defs=[...fields]
 const candidates=next.map((s,index)=>({s,index,e:era(s.mark?.kind==='eq'?s.mark.value:s.label)})).filter(x=>(x.s.ui==='circle'||x.s.ui==='check')&&x.e).sort((a,b)=>a.s.y-b.s.y||a.s.x-b.s.x)
 const groups:typeof candidates[]=[]
 for(const item of candidates){const g=groups.find(g=>Math.abs(g[0].s.y-item.s.y)<2&&Math.abs(g.at(-1)!.s.x-item.s.x)<16);if(g)g.push(item);else groups.push([item])}
 for(const group of groups){
  if(group.length<3||new Set(group.map(i=>i.e![0])).size!==group.length)continue
  const x0=Math.min(...group.map(i=>i.s.x)),x1=Math.max(...group.map(i=>i.s.x+i.s.w)),y=group[0].s.y
  const indices=new Set(group.map(i=>i.index))
  const dates=new Set(next.filter((s,index)=>(['y','m','d'].includes(s.part??'')||indices.has(index))&&s.ref&&Math.abs(s.y-y)<8&&s.x>=x0-35&&s.x<=x1+45).filter(s=>{
   const local=defs.find(d=>d.key===s.ref)
   const parsed=s.ref?parseRef(s.ref):null
   return local?.type==='date'||parsed&&specOf(parsed.ref)?.type==='date'
  }).map(s=>s.ref!))
  const shared=dates.size===1?[...dates][0]:undefined
  let key=shared
  if(!key){
   key=`local.p${page}_era_${group[0].index+1}`
   while(defs.some(f=>f.key===key))key+='x'
   defs.push({key,label:'元号',type:'enum',choices:group.map(i=>i.e![2]),note:'同じ生年月日欄の元号。選べるのは1つ。日付との対応は未確認。'})
  }
  for(const item of group)next[item.index]={...item.s,ui:'circle',ref:key,part:shared?'era':undefined,mark:{kind:'eq',value:item.e![2]}}
 }
 const used=new Set(next.map(s=>s.ref))
 return {slots:next,fields:defs.filter(f=>used.has(f.key))}
}
