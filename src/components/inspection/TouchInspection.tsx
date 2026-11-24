import {useState} from 'react'
import {PaperDialog} from '../care-paper/PaperDialog.tsx'
import {PetInspection,useInspections} from './PetInspection.tsx'
import type {InspectionContext} from './context.ts'
/** 右の常設パネルがないタッチ画面でも、同じ点検内容を開く。 */
export function TouchInspection({clientId,context}:{clientId:string;context?:InspectionContext}){
 const [open,setOpen]=useState(false),history=useInspections(context?clientId:undefined,context?.documentId)
 return <><button className="btn" type="button" disabled={!context} onClick={()=>setOpen(true)}>点検する</button>{open&&context&&<PaperDialog title="書類の点検" onClose={()=>setOpen(false)}><PetInspection key={context.documentId} clientId={clientId} documentId={context.documentId} beforeStart={context.beforeStart} list={history.list} reload={history.reload} onJump={(key,id)=>{if(id&&id!==context.documentId)return;setOpen(false);requestAnimationFrame(()=>context.jump(key))}}/></PaperDialog>}</>
}
