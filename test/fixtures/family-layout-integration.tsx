import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {familyFixtures} from './family-layout.ts'
import {diagramSvg} from '../../core/diagram/svg.ts'
import {nextDiagram,type DiagramValue} from '../../core/diagram/fields.ts'
import DiagramFieldEditor from '../../src/components/diagram/DiagramFieldEditor.tsx'
import beforeFour from './family-layout-before-four.svg?raw'
import beforeRemarried from './family-layout-before-remarried.svg?raw'
const fixtures=familyFixtures()
function Harness(){
 const [name,setName]=useState('four'),[editing,setEditing]=useState(false),[applied,setApplied]=useState<DiagramValue>()
 const doc=fixtures[name],svg=diagramSvg(doc,'family')
 return <main><h1>家族構成図の比較（架空データ）</h1><nav>{Object.keys(fixtures).map(key=><button key={key} onClick={()=>setName(key)}>{key}</button>)}<button onClick={()=>setEditing(true)}>この家族図を編集</button></nav>
 <div className="comparison"><section><h2>変更前</h2><div className="figure" data-before dangerouslySetInnerHTML={{__html:name==='four'?beforeFour:name==='remarried'?beforeRemarried:''}}/></section><section><h2>変更後</h2><div className="figure" data-after dangerouslySetInnerHTML={{__html:svg}}/></section></div>
 <output aria-label="反映した家族図">{JSON.stringify(applied)}</output>
 {editing&&<DiagramFieldEditor field={{id:'family.genogram',title:'家族構成図',kind:'family',value:nextDiagram('family',doc,0)}} onClose={()=>setEditing(false)} onApply={async value=>{setApplied(value);setEditing(false)}}/>}</main>
}
createRoot(document.getElementById('root')!).render(<Harness/>)
