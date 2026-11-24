import {useEffect,useRef} from 'react'
export interface InspectionContext {documentId:string;beforeStart:()=>Promise<boolean>;jump:(key:string)=>void}
export type OnInspectionContext=(context:InspectionContext|undefined)=>void
/** 親に通知する関数は安定させ、入力・点検操作は常に最新のものを使う。 */
export function useInspectionContext(onChange:OnInspectionContext|undefined,documentId:string|undefined,beforeStart:()=>Promise<boolean>,jump:(key:string)=>void) {
 const latest=useRef({beforeStart,jump});latest.current={beforeStart,jump}
 useEffect(()=>{onChange?.(documentId?{documentId,beforeStart:()=>latest.current.beforeStart(),jump:key=>latest.current.jump(key)}:undefined);return()=>onChange?.(undefined)},[onChange,documentId])
}

export function focusInspectionField(root:HTMLElement|null,label:string,key?:string) {
 const fields=root?.querySelectorAll<HTMLElement>('input[aria-label],textarea[aria-label],button[aria-label]')??[]
 const bound=key?root?.querySelector<HTMLElement>(`[data-field-key="${CSS.escape(key)}"]`):undefined
 const direct=bound?.matches('input,textarea,button')?bound:bound?.querySelector<HTMLElement>('input,textarea,button')
 const field=direct??[...fields].find(el=>(el.getAttribute('aria-label')??'').startsWith(label))
 field?.scrollIntoView({block:'center',inline:'nearest'});field?.focus({preventScroll:true});field?.classList.add('inspection-target-focus');setTimeout(()=>field?.classList.remove('inspection-target-focus'),2000)
}
