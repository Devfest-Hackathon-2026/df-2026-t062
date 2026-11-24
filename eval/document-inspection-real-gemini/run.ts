/** 実モデル専用。npm test/CIは呼ばない。--dryで入力・予算確認、--live --limit 1で接続確認後に--resume --limit 12。 */
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {parseArgs} from 'node:util'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {Models,type GenerateContentParameters,type GenerateContentResponse} from '@google/genai'
import {checkSet} from '../../core/checks/index.ts'
import {toFormDef} from '../../core/form.ts'
import {readSeed} from '../../forms/admin/files.ts'
import {inspect,type InspectDoc} from '../../worker/inspect/index.ts'
import {geminiFactory,type Llm} from '../../worker/vertex/gemini.ts'
import {ZERO_USAGE} from '../../worker/types.ts'
const {values:args}=parseArgs({options:{out:{type:'string'},live:{type:'boolean'},dry:{type:'boolean'},resume:{type:'boolean'},limit:{type:'string',default:'1'}}})
if(!args.out||!!args.live===!!args.dry)throw new Error('--out と --dry または --live を明示してください')
const limit=Number(args.limit)
if(!Number.isInteger(limit)||limit<1||limit>12)throw new Error('上限1〜12')
const env={...process.env}
if(args.live&&(env.AI_PROVIDER!=='vertex'||!env.GOOGLE_CLOUD_PROJECT||env.GEMINI_MODEL!=='gemini-3.8-flash'||env.GEMINI_LOCATION!=='global'))throw new Error('料金確認済みのvertex・project・モデル・globalを明示してください')
const out=resolve(args.out);await mkdir(out,{recursive:true})
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
type Scenario={id:string;kind:string;values:Record<string,unknown>;expected:Record<string,string>;why:string;references:{kind:string;values:Record<string,unknown>}[]}
const scenarios=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8')) as Scenario[]
const ledgerPath=join(out,'ledger.json')
const ledger: {sent:number;caseKeys:string[]}=args.resume?JSON.parse(await readFile(ledgerPath,'utf8')):{sent:0,caseKeys:[]}
if(!args.resume){try{await readFile(ledgerPath);throw new Error('既存ledgerは上書きしません')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
const upperUsd=12*(60000*.75+65536*3.75)/1e6
const environment={evaluatedCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),createdAt:new Date().toISOString(),provider:env.AI_PROVIDER??null,model:env.GEMINI_MODEL??null,location:env.GEMINI_LOCATION??null,projectSha256:hash(env.GOOGLE_CLOUD_PROJECT??''),auth:'既存ADC（秘密を記録しない）',maxRequests:12,upperUsd,productionHashes:Object.fromEntries(await Promise.all(['worker/inspect/index.ts','worker/inspect/prompt.ts','worker/vertex/gemini.ts','core/checks/rules.ts','core/checks/mhlw-careplan.json'].map(async p=>[p,hash(await readFile(p,'utf8'))])))}
await writeFile(join(out,'environment.json'),JSON.stringify(environment,null,2)+'\n')
let active:{id:string;capture?:Record<string,unknown>}|undefined
const proto=Models.prototype as unknown as {generateContentInternal:(p:GenerateContentParameters)=>Promise<GenerateContentResponse>}
const original=proto.generateContentInternal
if(args.live){
 if(typeof original!=='function')throw new Error('SDK観測箇所が変わっています')
 proto.generateContentInternal=async function(params){
  if(!active||active.capture||ledger.sent>=limit||ledger.sent>=12)throw new Error('追加呼出しを停止')
  const bytes=Buffer.byteLength(JSON.stringify({contents:params.contents,schema:params.config?.responseJsonSchema}))
  if(bytes>60000||(params.config?.maxOutputTokens??Infinity)>65536)throw new Error('見積もり上限超過')
  const a=active
  a.capture={startedAt:new Date().toISOString(),requestedModel:params.model,inputBytes:bytes,promptSha256:hash(JSON.stringify(params.contents)),schemaSha256:hash(JSON.stringify(params.config?.responseJsonSchema)),maxOutputTokens:params.config?.maxOutputTokens,thinkingLevel:params.config?.thinkingConfig?.thinkingLevel}
  ledger.sent++;ledger.caseKeys.push(a.id);await writeFile(ledgerPath,JSON.stringify(ledger,null,2)+'\n')
  const started=performance.now()
  try{
   const r=await original.call(this,{...params,config:{...params.config,httpOptions:{...params.config?.httpOptions,timeout:120000,retryOptions:{attempts:1}}}})
   Object.assign(a.capture,{elapsedMs:Math.round(performance.now()-started),responseId:r.responseId,modelVersion:r.modelVersion,finishReasons:r.candidates?.map(c=>c.finishReason),usage:r.usageMetadata,text:r.text??''})
   return r
  }catch(e){Object.assign(a.capture,{elapsedMs:Math.round(performance.now()-started),error:{name:(e as Error).name,status:(e as {status?:number}).status}});throw e}
 }
}
const doc=(id:string,kind:string,values:Record<string,unknown>):InspectDoc=>({id,kind,kindName:readSeed(kind).name,form:toFormDef({...readSeed(kind),id:`eval-${kind}`,version:1,contentSha:'eval'}),values})
const dryLlm=():Llm=>{const usage={...ZERO_USAGE};return {async ask(prompt,schema){const bytes=Buffer.byteLength(JSON.stringify({contents:prompt,schema}));if(bytes>60000)throw new Error('入力上限超過');usage.calls++;usage.promptTokens+=bytes;const ids=Object.keys((schema as {properties:{results:{properties:Record<string,unknown>}}}).properties.results.properties);return {results:Object.fromEntries(ids.map(id=>[id,{level:'1',missing:'見積もり用'}]))}},usage:()=>usage}}
try{
 for(const s of scenarios){
  if(ledger.caseKeys.includes(s.id))continue
  if(args.live&&ledger.sent>=limit)break
  active={id:s.id};const before=performance.now()
  const llm=args.dry?dryLlm():geminiFactory(env,{retries:0,timeoutMs:120000})()
  try{
   const result=await inspect({set:checkSet('mhlw-careplan@2026-03'),docs:[doc(s.id,s.kind,s.values)],contextDocs:s.references.map((d,i)=>doc(`${s.id}-ref${i}`,d.kind,d.values)),llm})
   const comparisons=Object.entries(s.expected).map(([id,expected])=>{const f=result.findings.find(f=>f.item===id);return {id,expected,actual:f?.level??null,exact:expected===f?.level,missed:expected==='1'&&f?.level!=null&&f.level!=='1',extra:expected!=='1'&&f?.level==='1'}})
   const record={id:s.id,synthetic:true,dry:!!args.dry,why:s.why,elapsedMs:Math.round(performance.now()-before),captured:active.capture,result,comparisons}
   await writeFile(join(out,`${s.id}.json`),JSON.stringify(record,null,2)+'\n')
   console.log(JSON.stringify({id:s.id,realRequests:ledger.sent,dry:!!args.dry,items:comparisons.length,exact:comparisons.filter(c=>c.exact).length,missed:comparisons.filter(c=>c.missed).map(c=>c.id),usage:result.usage}))
  }catch(e){await writeFile(join(out,`${s.id}.json`),JSON.stringify({id:s.id,synthetic:true,dry:!!args.dry,captured:active.capture,error:{name:(e as Error).name}},null,2)+'\n');console.log(JSON.stringify({id:s.id,status:'failed',name:(e as Error).name}));process.exitCode=1;break}
  active=undefined
 }
}finally{proto.generateContentInternal=original}
