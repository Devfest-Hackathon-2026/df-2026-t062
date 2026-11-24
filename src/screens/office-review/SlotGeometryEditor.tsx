import { useState } from 'react'
import { geometryProblem, type SlotGeometry } from '../../../core/slot-geometry.ts'
export function SlotGeometryEditor({box,page,disabled,onSave}:{box:SlotGeometry;page:{width:number;height:number};disabled:boolean;onSave:(box:SlotGeometry)=>Promise<void>}) {
 const [value,setValue]=useState(()=>Object.fromEntries(Object.entries(box).map(([key,n])=>[key,String(n)])) as Record<keyof SlotGeometry,string>)
 const [error,setError]=useState('')
 const save=async()=>{
  const next={x:parseFloat(value.x),y:parseFloat(value.y),w:parseFloat(value.w),h:parseFloat(value.h)}
  const problem=geometryProblem(next,page)
  if(problem){setError(problem);return}
  setError('')
  try{await onSave(next)}catch(e){setError(e instanceof Error?e.message:'位置を保存できませんでした。')}
 }
 return <fieldset className="of-geometry" disabled={disabled}><legend>位置・大きさ（mm）</legend>
  <div>{([['x','左から'],['y','上から'],['w','幅'],['h','高さ']] as const).map(([key,label])=><label key={key}>{label}<input type="number" step="0.1" aria-label={label+'（mm）'} value={value[key]} onChange={e=>setValue(old=>({...old,[key]:e.target.value}))}/></label>)}</div>
  {error&&<p role="alert" className="of-err">{error}</p>}<button className="btn btn-s" type="button" onClick={()=>void save()}>位置を保存</button>
 </fieldset>
}
