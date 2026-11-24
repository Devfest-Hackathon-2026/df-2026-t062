/** 保存した実応答だけを集計。AIを呼び直さない。 */
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
const dir=resolve(process.argv[2]??'eval/document-inspection-real-gemini/results')
const cases=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8')) as {id:string;expected:Record<string,string>}[]
const records:Record<string,any>[]=[]
for(const c of cases){try{records.push(JSON.parse(await readFile(join(dir,`${c.id}.json`),'utf8')))}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
const comparisons=records.flatMap(r=>(r.comparisons??[]).map((c:Record<string,unknown>)=>({scenario:r.id,...c})))
const successful=records.filter(r=>r.captured?.responseId&&!r.error&&!r.dry)
const sum=(key:string)=>successful.reduce((n,r)=>n+Number(r.captured.usage?.[key]??0),0)
const input=sum('promptTokenCount'),output=sum('candidatesTokenCount'),thinking=sum('thoughtsTokenCount'),cached=sum('cachedContentTokenCount')
const seconds=successful.map(r=>r.captured.elapsedMs/1000)
const rawDifferences=successful.flatMap(r=>{const raw=JSON.parse(r.captured.text).results;return r.result.findings.filter((f:{item:string;level:string})=>raw[f.item]?.level!==f.level).map((f:{item:string;level:string})=>({scenario:r.id,id:f.item,model:raw[f.item]?.level,application:f.level}))})
const report={generatedAt:new Date().toISOString(),successful:successful.length,failed:records.filter(r=>r.error).length,notExecuted:cases.filter(c=>!records.some(r=>r.id===c.id)).map(c=>c.id),uniqueItems:new Set(comparisons.map(c=>c.id)).size,judgments:comparisons.length,exact:comparisons.filter(c=>c.exact).length,missed:comparisons.filter(c=>c.missed),extra:comparisons.filter(c=>c.extra),unjudged:comparisons.filter(c=>c.actual==null),diff:comparisons.filter(c=>!c.exact),rawDifferences,input,output,thinking,cached,estimatedUsd:(input*.75+(output+thinking)*3.75)/1e6,latencySeconds:{min:seconds.length?Math.min(...seconds):null,max:seconds.length?Math.max(...seconds):null,mean:seconds.length?seconds.reduce((a,b)=>a+b,0)/seconds.length:null},cases:records.map(r=>({id:r.id,status:r.error?'failed':r.dry?'dry':'success',exact:r.comparisons?.filter((c:{exact:boolean})=>c.exact).length,total:r.comparisons?.length,seconds:r.captured?.elapsedMs/1000}))}
await writeFile(join(dir,'summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
