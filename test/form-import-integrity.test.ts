import assert from 'node:assert/strict'
import { test } from 'node:test'
import { correctPrintedGeometry, normalizeEraChoices } from '../worker/form-import/integrity.ts'
import { buildVersion } from '../worker/form-import/version.ts'
import { checkDraftVersion } from '../worker/form-import/check.ts'
import type { DraftSlot } from '../worker/form-import/draft.ts'
import type { PageDraft } from '../worker/form-import/convert.ts'
const slot=(change:Partial<DraftSlot>={}):DraftSlot=>({x:20,y:20,w:12,h:4,ui:'circle',ref:'intake.method',label:'来所',confidence:.9,...change})
const word=(t:string,x0:number,y0=20)=>({t,x0,y0,x1:x0+t.length*3,y1:y0+3})
test('丸の枠は単語全体を囲み、同名候補が同程度に近ければ確定しない',()=>{
 const [s]=correctPrintedGeometry([slot({x:20,w:3})],{words:[word('来所',18)],chars:[]})
 assert.ok(s.x<18);assert.ok(s.x+s.w>24)
 const ambiguous=slot({x:22.5,w:3})
 assert.deepEqual(correctPrintedGeometry([ambiguous],{words:[word('来所',18),word('来所',24)],chars:[]})[0],ambiguous)
})
test('Tel文字の後ろから入力し、図には文字避けを適用しない',()=>{
 const p={words:[word('Tel',20)],chars:[]}
 const original=slot({ui:'text',ref:'local.tel',label:'Tel',w:30,h:10})
 const [s]=correctPrintedGeometry([original],p)
 assert.ok(s.x>29);assert.equal(s.x+s.w,50)
 const diagram=slot({ui:'diagram',ref:'family.genogram',w:30,h:10})
 assert.deepEqual(correctPrintedGeometry([diagram],p)[0],diagram)
})
test('M/T/Sを3個の独立boolにせず、同じ行の生年月日に結び付ける',()=>{
 const marks=['M','T','S'].map((label,i)=>slot({x:20+i*5,w:3,label,ref:'local.era'+i,mark:{kind:'true'}}))
 const date=slot({x:40,ui:'text',label:'生年月日 年',part:'y',ref:'person.birthDate'})
 const r=normalizeEraChoices([...marks,date],marks.map((_,i)=>({key:'local.era'+i,label:'元号',type:'bool' as const})))
 assert.ok(r.slots.slice(0,3).every(s=>s.ref==='person.birthDate'&&s.part==='era'))
 const v=buildVersion([{page:1,width:210,height:297,slots:r.slots,localFields:r.fields,problems:[],cells:[],boxes:[],rounds:[],outside:0}])
 assert.deepEqual(Object.values(v.bindings).filter(b=>b.op==='era@1').map(b=>b.era),['M','T','S'])
 assert.deepEqual(checkDraftVersion(v),[])
})
test('日付の根拠がないM/T/Sは共通の単一選択にし、別の行とは混ぜない',()=>{
 const marks=['M','T','S'].map((label,i)=>slot({x:20+i*5,w:3,label,ref:'local.era'+i}))
 const other=slot({x:20,y:50,label:'M',ref:'local.other'})
 const r=normalizeEraChoices([...marks,other],[])
 const first=r.slots.slice(0,3)
 assert.equal(new Set(first.map(s=>s.ref)).size,1)
 assert.equal(r.fields.find(f=>f.key===first[0].ref)?.type,'enum')
 assert.equal(r.slots[3].ref,'local.other')
})
test('図の入れ子を文字に結び付けず、既存の誤った図の文字bindingは公開検証で拒否する',()=>{
 const v=buildVersion([{page:1,width:210,height:297,slots:[slot({ui:'area',label:'家族構成',ref:'family.genogram.nodes'})],localFields:[],problems:[],cells:[],boxes:[],rounds:[],outside:0}] as PageDraft[])
 assert.equal(Object.values(v.bindings)[0].op,'diagram@1');assert.equal(v.schemas[0][0].type,'image')
 const invalid={...v,schemas:[[{...v.schemas[0][0],type:'text' as const}]],bindings:{[v.schemas[0][0].name]:{op:'text@1' as const,ui:'text' as const,ref:{key:'family.genogram'}}}}
 assert.ok(checkDraftVersion(invalid).length>0)
})

import { geometryProblem } from '../core/slot-geometry.ts'
import { editSlot,renderSlot } from '../core/binding.ts'
test('位置修正は全種類に同じ用紙境界を適用し、対応を変えずにはみ出しを拒否する',()=>{
 assert.equal(geometryProblem({x:20,y:30,w:10,h:5},{width:297,height:210}),null)
 assert.ok(geometryProblem({x:290,y:30,w:10,h:5},{width:297,height:210}))
 assert.ok(geometryProblem({x:20,y:30,w:0,h:5},{width:297,height:210}))
 assert.ok(geometryProblem({x:NaN,y:30,w:10,h:5},{width:297,height:210}))
 const v=buildVersion([{page:1,width:210,height:297,slots:[slot({x:209,ref:'person.name',ui:'text'})],localFields:[],problems:[],cells:[],boxes:[],rounds:[],outside:0}])
 assert.ok(checkDraftVersion(v).some(p=>p.includes('用紙の外')))
})

test('元号の既存の日付対応を保持し、単一選択を切り替えると他の丸は外れる',()=>{
 const marks=['M','T','S'].map((label,i)=>slot({x:20+i*5,w:3,label,ref:'person.birthDate',part:'era'}))
 const r=normalizeEraChoices(marks,[])
 assert.ok(r.slots.every(s=>s.ref==='person.birthDate'&&s.part==='era'))
 const local=normalizeEraChoices(marks.map(s=>({...s,ref:null})),[])
 const v=buildVersion([{page:1,width:210,height:297,slots:local.slots,localFields:local.fields,problems:[],cells:[],boxes:[],rounds:[],outside:0}])
 const names=Object.keys(v.bindings), key=local.slots[0].ref!
 const selected={ [key]:'明治' }
 const change=editSlot(v.bindings,selected,names[2],'true')
 assert.ok('changes' in change)
 const values={...selected,...Object.fromEntries(change.changes.map(c=>[c.key,c.value]))}
 assert.deepEqual(names.map(n=>renderSlot(v.bindings[n],values)),['false','false','true'])
})
test('PDFの文字単位の幅で、続いた語の選択肢とローマ数字を囲む',()=>{
 const chars=[..."来所・電話"].map((t,i)=>({...word(t,20+i*3),b:23,s:3,ink:null}))
 const [s]=correctPrintedGeometry([slot({x:20,w:3})],{chars,words:[word('来所・電話',20)]})
 assert.equal(s.x,19.6);assert.equal(s.w,6.8)
 const [roman]=correctPrintedGeometry([slot({label:'Ⅰ',ref:'local.level',x:20,w:2})],{chars:[{...word('Ⅰ',20),b:23,s:3,ink:null}],words:[]})
 assert.equal(roman.x,19.6)
})
