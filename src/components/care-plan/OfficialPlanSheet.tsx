import type { NeedInput, SlotInput } from '../../../db/care-plans.ts'
import { FormPage } from '../document/FormPage.tsx'
import type { DocState } from '../document/useDocument.ts'
import { officialPlanPages } from './paper.ts'

export interface PaperNeedTarget {
  needIndex: number
  goalIndex?: number
  serviceIndex?: number
}

/** 公式の原紙画像に入力値と操作領域だけを重ねる。独自の表・罫線は描かない。 */
export function OfficialPlanSheet({ state, needs, slots, touch, busy, readOnly, zoom, changed, aiChanged, onNeed, onNeeds, onSchedule, onActivities }: {
  state: DocState, needs: NeedInput[], slots: SlotInput[], touch: boolean, busy: boolean, readOnly: boolean,
  zoom: number, changed: boolean, aiChanged: boolean, onNeed: (target: PaperNeedTarget, field: string) => void,
  onNeeds: () => void, onSchedule: () => void, onActivities: () => void,
}) {
  if (!state.form) return null
  const pages = officialPlanPages(state.form, state.current, needs, slots)
  const rowTargets: PaperNeedTarget[] = needs.flatMap((need, needIndex) =>
    need.shortGoals?.length
      ? need.shortGoals.flatMap((goal, goalIndex) => goal.services?.length
        ? goal.services.map((_, serviceIndex) => ({ needIndex, goalIndex, serviceIndex }))
        : [{ needIndex, goalIndex }])
      : [{ needIndex }])
  const action = readOnly ? '内容を確認' : '押して編集'
  return <div className="cp-first-scroll">{pages.map((printed, index) => {
    const page = state.pages.find((p) => p.pdfIndex === printed.sourceIndex)!
    const layout = page.print
    if (!layout || layout.type === 'text' || layout.type === 'flow' || layout.type === 'sections') return null
    const structural = new Set(layout.type === 'table' ? layout.slots : [layout.slot, layout.activity?.slot, '週単位以外'])
    const rowsPerPage = layout.type === 'table' ? layout.rowsPerPage : 0
    const fields = printed.schemas.filter((s) =>
      s.name.includes('__row') || s.name.includes('__slot') || structural.has(s.name))
    const blankRow = rowTargets.length - index * rowsPerPage
    const paperArea = (name: string | undefined, label: string, open: () => void, topOffset = 0) => {
      const slot = page.slots.find((s) => s.name === name)
      return slot && <button className="cp-paper-field cp-paper-area" type="button" disabled={busy}
        aria-label={`${label}（${action}）`} onClick={open}
        style={{ left: `${slot.x / page.width * 100}%`, top: `${(slot.y + topOffset) / page.height * 100}%`,
          width: `${slot.w / page.width * 100}%`, height: `${slot.h / page.height * 100}%` }} />
    }
    return <div key={index} className="cp-first" style={{ width: `${zoom}%`, maxWidth: Math.round(1120 * zoom / 100) }}>
      <div className="plabel">{page.title}{pages.length > 1 ? ` ・ ${index + 1} / ${pages.length}` : ''}</div>
      <FormPage page={{ ...page, slots: page.slots.filter((s) => !structural.has(s.name)) }}
        state={state} touch={touch} disabled={busy || readOnly} batchLabel="ケアプランのAI原案" combinedSave>
        {layout.type === 'timeline' && <>
          {paperArea(layout.slot, '週間予定', onSchedule)}
          {paperArea(layout.activity?.slot, '主な日常生活上の活動', onActivities)}
        </>}
        {fields.map((s) => {
          const row = s.name.match(/__row(\d+)$/)
          const target = rowTargets[index * rowsPerPage + Number(row?.[1] ?? 0)]
          const field = s.name.replace(/__row\d+|__slot\d+/, '')
          const isActivity = layout.type === 'timeline' && s.name.startsWith(layout.activity?.slot ?? '\0')
          const open = layout.type === 'table'
            ? target === undefined ? onNeeds : () => onNeed(target, field)
            : isActivity ? onActivities : onSchedule
          return <button key={s.name} type="button" disabled={busy} className={`cp-paper-field${changed ? ' cp-hand' : aiChanged ? ' cp-ai' : ''}`}
            aria-label={`${field}（${action}）`}
            onClick={open} style={{
              left: `${s.position.x / page.width * 100}%`, top: `${s.position.y / page.height * 100}%`,
              width: `${s.width / page.width * 100}%`, height: `${s.height / page.height * 100}%`,
              fontSize: `${(s.fontSize ?? 8) * .3528 / page.width * 100}cqw`, lineHeight: s.lineHeight ?? 1.15,
            }}>{printed.input[s.name]}</button>
        })}
        {layout.type === 'table' && !readOnly && blankRow > 0 && blankRow < rowsPerPage
          && paperArea(layout.slots[0], '空いているニーズ欄', onNeeds, blankRow * layout.rowHeight)}
      </FormPage>
    </div>
  })}</div>
}
