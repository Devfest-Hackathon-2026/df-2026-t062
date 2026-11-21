import bodyImage from '../../../core/diagram/body.png'
import type { Doc, Tab } from '../../../core/diagram/model.ts'
import { diagramSvg } from '../../../core/diagram/svg.ts'
/** Content comes exclusively from the validated diagram model; strings are XML escaped. */
export default function Preview({ doc, tab, editing, cropBody, selected, bodyView }: { doc: Doc, tab: Tab, editing?: boolean, cropBody?: boolean, selected?: string, bodyView?: 'front' | 'back' }) {
  return <div className="diagram-preview" dangerouslySetInnerHTML={{ __html: diagramSvg(doc, tab, { editing, cropBody, selected, bodyView, bodyImage }) }} />
}
