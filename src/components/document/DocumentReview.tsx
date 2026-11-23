import {useRef,useState,useEffect} from 'react'
import {api,ApiError,type DocumentView} from '../../lib/api.ts'
import {sameValue} from '../../../core/apply-batch.ts'
import {subFieldsOf,type FieldSpec} from '../../../core/fields.ts'
import {GLOBAL_DICT,type FieldDict} from '../../../core/dictionary.ts'
import {diagramSchema,diagramDocument} from '../../../core/diagram/fields.ts'
import Preview from '../diagram/Preview.tsx'
import {downloadBlob} from '../../lib/download.ts'
function text(v:unknown,spec?:FieldSpec):string {
 if(v==null)return '空欄'
 if(Array.isArray(v))return v.map(item=>text(item,spec)).join(' ／ ')
 if(typeof v==='object')return Object.entries(v).map(([k,value])=>{const child=spec&&subFieldsOf(spec).find(s=>s.key===k);return `${child?.label??k}：${text(value,child)}`}).join('、')
 return typeof v==='boolean'?(v?'あり':'なし'):String(v)
}
function content(value:unknown,spec?:FieldSpec){const parsed=diagramSchema.safeParse(value);return parsed.success?<Preview doc={diagramDocument(parsed.data)} tab={parsed.data.kind}/>:text(value,spec)}
/** 保存は確認扱いにしない。ダイアログを開いたときの内容を保持し、サーバーでも版を照合する。 */
export function DocumentReview({doc,dict=GLOBAL_DICT,flush,reload}:{doc:DocumentView|null;dict?:FieldDict;flush:()=>Promise<boolean>;reload:()=>unknown}) {
 const [snapshot,setSnapshot]=useState<DocumentView|null>(null)
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const dialog=useRef<HTMLDialogElement>(null)
 useEffect(()=>{if(snapshot)dialog.current?.showModal()},[snapshot])
 if(!doc||/^care_plan_[1-7]$/.test(doc.kind))return null
 const open=async()=>{setBusy(true);setError('');try{if(await flush()){const r=await api.document(doc.id);setSnapshot(r.document)}}catch{setError('内容を取得できませんでした。もう一度お試しください。')}finally{setBusy(false)}}
 const exportFormal=async()=>{if(!snapshot?.confirmation)return;setBusy(true);setError('');try{downloadBlob(await api.pdf(snapshot.id,snapshot.confirmation.rev),`正式版_第${snapshot.confirmation.rev}版.pdf`)}catch{setError('正式版を出力できませんでした。')}finally{setBusy(false)}}
 const action=async(kind:'review'|'unreview'|'confirm')=>{
  if(!snapshot)return
  setBusy(true);setError('')
  try{
   const fields=Object.entries(snapshot.fields).filter(([,f])=>kind==='review'?!f.reviewedAt:!!f.reviewedAt).map(([key,f])=>({key,valueVersion:f.valueVersion!,base:f.value}))
   const r=kind==='confirm'?await api.confirmDocument(snapshot.id,snapshot.rev):await api.reviewFields(snapshot.id,snapshot.formVersionId,fields,kind==='review')
   setSnapshot(r.document);await reload()
  }catch(e){setError(e instanceof ApiError&&e.status===409?'内容または保存版が変わりました。閉じてから開き直し、確認してください。':'処理できませんでした。入力内容は保持されています。')}finally{setBusy(false)}
 }
 const currentFormal=doc.confirmation?.rev===doc.rev&&sameValue(Object.fromEntries(Object.entries(doc.fields).map(([k,f])=>[k,f.value])),Object.fromEntries(Object.entries(doc.saved).map(([k,f])=>[k,f.value])))
 const fields=snapshot?Object.entries(snapshot.fields):[]
 const pending=fields.filter(([,f])=>!f.reviewedAt).length
 const saved=snapshot&&snapshot.rev>0&&sameValue(Object.fromEntries(fields.map(([k,f])=>[k,f.value])),Object.fromEntries(Object.entries(snapshot.saved).map(([k,f])=>[k,f.value])))
 return <div className="document-review-control">
  <button className="btn" type="button" disabled={busy} onClick={()=>void open()}>確認・確定</button>
  {doc.confirmation&&<small>正式版 第{doc.confirmation.rev}版{!currentFormal&&' ／ 現在は編集中'}</small>}
  {!snapshot&&error&&<span role="alert">{error}</span>}
  {snapshot&&<dialog ref={dialog} className="document-review-dialog" aria-label="書類の確認と確定" onCancel={e=>{if(busy)e.preventDefault();else setSnapshot(null)}}>
   <h2>書類の確認と確定</h2>
   <p>保存しただけでは確認済みになりません。内容を確認すると、その値をAIが書き換えなくなります。</p>
   <p>保存版：{snapshot.rev?`第${snapshot.rev}版`:'未保存'} ／ 未確認：{pending}件</p>
   <dl>{fields.map(([key,f])=><div key={key}><dt>{dict.get(key)?.label??'項目'} <small>{f.by==='ai'?'AI入力':'手入力'}・{f.reviewedAt?'確認済み':'未確認'}</small></dt><dd>{content(f.value,dict.get(key))}</dd></div>)}</dl>
   {!saved&&<p>正式版にするには、現在の入力内容を保存してください。</p>}
   {snapshot.confirmation&&<p>正式版：第{snapshot.confirmation.rev}版（確定後の編集はこの版に影響しません）</p>}
   {error&&<p role="alert">{error}</p>}
   <p><small>通常の書類出力は最新の保存版です。正式版は下の「正式版を出力」から出力できます。</small></p>
   <div className="document-review-actions">
    <button className="btn" disabled={busy} onClick={()=>{dialog.current?.close();setSnapshot(null)}}>閉じる</button>
    {snapshot.confirmation&&<button className="btn" disabled={busy} onClick={()=>void exportFormal()}>正式版を出力</button>}
    <button className="btn" disabled={busy||pending===fields.length} onClick={()=>void action('unreview')}>確認を取り消す</button>
    <button className="btn" disabled={busy||pending===0} onClick={()=>void action('review')}>表示した内容を確認</button>
    <button className="btn btn-p" disabled={busy||pending>0||!fields.length||!saved||snapshot.confirmation?.rev===snapshot.rev} onClick={()=>void action('confirm')}>正式版として確定</button>
   </div>
   <p><small>確認を取り消すと、AI入力の値は再更新の対象になります。正式版は保存版として残ります。</small></p>
  </dialog>}
 </div>
}
