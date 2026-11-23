import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { unzipSync, strFromU8 } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import { FEE_MASTER, type FeeInput, type FeeResult, type FeeWorkbookCheck } from '../core/care-fees.ts'
import type { CareMonthSaved } from '../core/care-month-api.ts'
import { canonical } from './care-plans.ts'

type Ref={sheet:string;row:number;col:number}
const FormulaParser=createRequire(import.meta.url)('fast-formula-parser') as new(options:{onCell:(r:Ref)=>number;onRange:(r:{sheet:string;from:Ref;to:Ref})=>number[][]})=>{parse:(formula:string,position:Ref)=>unknown}
export const FEE_WORKBOOK={id:'body1-v1',sha256:'7d717338930b8ab8e0c240f561e9f725ecc535dc22389b92d740222f2963b7f9',engine:'fast-formula-parser@1.0.19'} as const
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex')
const outputs={count:'B4',units:'B6',priceHundredths:'B7',gross:'B8',benefit:'B9',patient:'B10',limit:'B11',remaining:'B12'} as const

/** Only the bundled, checksum-pinned template is evaluated. Cached XLSX results are never trusted. */
export async function verifyFeeWorkbook(source:CareMonthSaved,input:FeeInput,result:FeeResult):Promise<FeeResult> {
 if(result.status!=='calculated')return result
 const bytes=await readFile(new URL('../core/fee-workbooks/body1-v1.xlsx',import.meta.url))
 if(createHash('sha256').update(bytes).digest('hex')!==FEE_WORKBOOK.sha256)throw new Error('算定テンプレートの整合性を確認できません。第7表への反映を中止しました。')
 const files=unzipSync(bytes),xml=new XMLParser({ignoreAttributes:false,parseTagValue:false,isArray:name=>name==='row'||name==='c'})
 type Cell={formula?:string;value?:unknown}
 const sheets=new Map<string,Map<string,Cell>>()
 for(const [name,path]of [['算定','xl/worksheets/sheet1.xml'],['入力','xl/worksheets/sheet2.xml']]){
  const cells=new Map<string,Cell>()
  const parsed=xml.parse(strFromU8(files[path])) as {worksheet:{sheetData:{row:{c:{'@_r':string;'@_t'?:string;f?:string;v?:string}[]}[]}}}
  for(const row of parsed.worksheet.sheetData.row)for(const c of row.c)cells.set(c['@_r'],{formula:c.f,value:c['@_t']?c.v:c.v===undefined?undefined:Number(c.v)})
  sheets.set(name,cells)
 }
 const put=(row:number,col:number,value:unknown)=>sheets.get('入力')!.set(`${String.fromCharCode(64+col)}${row}`,{value})
 const transferred=[source.month.month,input.basis,input.region,input.masterId,(FEE_MASTER.limits as Record<string,number>)[input.careLevel!],(FEE_MASTER.priceHundredths as Record<string,number>)[input.region!],input.copay,source.month.id,source.revision,source.savedAt,hash(source)]
 transferred.forEach((v,i)=>put(i+2,2,v))
 // Transcribe original statuses independently of the calculator's selected entry IDs.
 source.month.entries.forEach((e,i)=>{const row=i+16;[e.id,e.serviceId,e.plan.date,e.plan.status,e.actual?.status??'未入力',Number(input.basis==='planned'?e.plan.status==='scheduled':e.actual?.status==='provided')].forEach((v,col)=>put(row,col+1,v))})
 if(source.month.entries.length>5000)throw new Error('算定テンプレートの行数上限を超えています')
 const cache=new Map<string,number>(),stack=new Set<string>()
 const read=(ref:Ref):number=>{
  const key=`${ref.sheet}:${ref.row}:${ref.col}`
  if(cache.has(key))return cache.get(key)!
  if(stack.has(key))throw new Error('算定テンプレートに循環参照があります')
  if(!['算定','入力'].includes(ref.sheet)||ref.row<1||ref.row>5015||ref.col<1||ref.col>6)throw new Error('算定テンプレートの参照範囲が不正です')
  const cell=sheets.get(ref.sheet)!.get(`${String.fromCharCode(64+ref.col)}${ref.row}`)
  stack.add(key)
  const value=cell?.formula?parser.parse(cell.formula,ref):cell?.value??0
  stack.delete(key)
  if(typeof value!=='number'||!Number.isFinite(value))throw new Error('算定テンプレートの数式を再計算できません')
  cache.set(key,value);return value
 }
 const parser=new FormulaParser({onCell:read,onRange:r=>{
  if(r.to.row-r.from.row>5000||r.to.col-r.from.col>5)throw new Error('参照範囲が広すぎます')
  return Array.from({length:r.to.row-r.from.row+1},(_,i)=>Array.from({length:r.to.col-r.from.col+1},(_,j)=>read({sheet:r.sheet,row:r.from.row+i,col:r.from.col+j})))
 }})
 const actual:Record<string,number>={}
 for(const [key,address]of Object.entries(outputs)){
  actual[key]=read({sheet:'算定',row:Number(address.slice(1)),col:2})
  if(actual[key]!==result[key as keyof typeof outputs])throw new Error('Excel数式と既存算定の結果が一致しません。第7表への反映を中止しました。')
 }
 const workbookCheck:FeeWorkbookCheck={templateId:FEE_WORKBOOK.id,templateHash:FEE_WORKBOOK.sha256,inputHash:hash({source,input}),engine:FEE_WORKBOOK.engine,status:'matched',outputs:actual}
 return {...result,workbookCheck}
}
