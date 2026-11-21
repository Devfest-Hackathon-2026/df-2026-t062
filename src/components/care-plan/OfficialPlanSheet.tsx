import type { NeedInput, SlotInput } from '../../../db/care-plans.ts'
import { FormPage } from '../document/FormPage.tsx'
import type { DocState } from '../document/useDocument.ts'
import { officialPlanPages } from './paper.ts'

/** 公式の原紙画像に入力値と操作領域だけを重ねる。独自の表・罫線は描かない。 */
export function OfficialPlanSheet({ state, needs, slots, touch, busy, readOnly, zoom, changed, aiChanged, onNeed, onSchedule, onActivities }: {
  state: DocState, needs: NeedInput[], slots: SlotInput[], touch: boolean, busy: boolean, readOnly: boolean,
  zoom: number, changed: boolean, aiChanged: boolean, onNeed: (index: number) => void, onSchedule: () => void, onActivities: () => void,
}) {
  if (!state.form) return null
  const pages = officialPlanPages(state.form, state.current, needs, slots)
  const rowNeeds = needs.flatMap((n, index) =>
    (n.shortGoals?.length ? n.shortGoals : [null]).flatMap((g) =>
      Array.from({ length: Math.max(1, g?.services?.length ?? 0) }, () => index)))
  return <div className="cp-first-scroll">{pages.map((printed, index) => {
    const page = state.pages.find((p) => p.pdfIndex === printed.sourceIndex)!
    const layout = page.print
    if (!layout || layout.type === 'text') return null
    const structural = new Set(layout.type === 'table' ? layout.slots : [layout.slot, layout.activity?.slot, '週単位以外'])
    const rowsPerPage = layout.type === 'table' ? layout.rowsPerPage : 0
    const fields = printed.schemas.filter((s) =>
      s.name.includes('__row') || s.name.includes('__slot') || structural.has(s.name))
    return <div key={index} className="cp-first" style={{ width: `${zoom}%`, maxWidth: Math.round(1120 * zoom / 100) }}>
      <div className="plabel">{page.title}{pages.length > 1 ? ` ・ ${index + 1} / ${pages.length}` : ''}</div>
      <FormPage page={{ ...page, slots: page.slots.filter((s) => !structural.has(s.name)) }}
        state={state} touch={touch} disabled={busy || readOnly} batchLabel="ケアプランのAI原案" combinedSave>
        {fields.map((s) => {
          const row = s.name.match(/__row(\d+)$/)
          const isActivity = layout.type === 'timeline' && s.name.startsWith(layout.activity?.slot ?? '\0')
          const open = layout.type === 'table'
            ? () => onNeed(rowNeeds[index * rowsPerPage + Number(row?.[1] ?? 0)] ?? 0)
            : isActivity ? onActivities : onSchedule
          return <button key={s.name} type="button" disabled={busy} className={`cp-paper-field${changed ? ' cp-hand' : aiChanged ? ' cp-ai' : ''}`}
            aria-label={`${s.name.replace(/__row\d+|__slot\d+/, '')}（${readOnly ? '内容を確認' : '押して編集'}）`}
            onClick={open} style={{
              left: `${s.position.x / page.width * 100}%`, top: `${s.position.y / page.height * 100}%`,
              width: `${s.width / page.width * 100}%`, height: `${s.height / page.height * 100}%`,
              fontSize: `${(s.fontSize ?? 8) * .3528 / page.width * 100}cqw`, lineHeight: s.lineHeight ?? 1.15,
            }}>{printed.input[s.name]}</button>
        })}
        {layout.type === 'timeline' && !fields.some((s) => s.name.startsWith(layout.slot)) && (() => {
          const area = page.slots.find((s) => s.name === layout.slot)
          return area && <button className="cp-paper-field" type="button" disabled={busy} aria-label="週間予定（押して編集）" onClick={onSchedule}
            style={{ left: `${area.x / page.width * 100}%`, top: `${area.y / page.height * 100}%`, width: `${area.w / page.width * 100}%`, height: `${area.h / page.height * 100}%` }} />
        })()}
      </FormPage>
    </div>
  })}</div>
}
