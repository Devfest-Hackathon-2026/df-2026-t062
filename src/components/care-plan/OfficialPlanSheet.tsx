import type { CSSProperties } from 'react'
import type { NeedInput, SlotInput } from '../../../db/care-plans.ts'
import { PaperText, type PaperTextField } from '../care-paper/PaperText.tsx'
import { FormPage } from '../document/FormPage.tsx'
import type { DocState } from '../document/useDocument.ts'
import { officialPlanPages } from './paper.ts'

export interface PaperNeedTarget {
  needIndex: number
  goalIndex?: number
  serviceIndex?: number
}

/** 公式の原紙画像に入力値と操作領域だけを重ねる。独自の表・罫線は描かない。 */
export function OfficialPlanSheet({ state, needs, slots, touch, busy, readOnly, zoom, changed, aiChanged, onNeed, onNeeds, onSchedule, onActivities, needText, activityText, otherNotes }: {
  state: DocState, needs: NeedInput[], slots: SlotInput[], touch: boolean, busy: boolean, readOnly: boolean,
  zoom: number, changed: boolean, aiChanged: boolean, onNeed: (target: PaperNeedTarget, field: string) => void,
  onNeeds: () => void, onSchedule: () => void, onActivities: () => void,
  needText?: (target: PaperNeedTarget, slot: string) => PaperTextField | undefined,
  activityText?: (hour: string) => PaperTextField | undefined,
  otherNotes?: PaperTextField[],
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
          const group = layout.type === 'table' ? layout.groupSlots?.findIndex(names => names.includes(field)) ?? -1 : -1
          const rowNumber = Number(row?.[1] ?? 0)
          const previous = rowNumber ? rowTargets[index * rowsPerPage + rowNumber - 1] : undefined
          const repeated = group >= 0 && target && previous?.needIndex === target.needIndex
            && (group === 0 || previous.goalIndex === target.goalIndex)
          const open = layout.type === 'table'
            ? target === undefined ? onNeeds : () => onNeed(target, field)
            : isActivity ? onActivities : onSchedule
          const style: CSSProperties = {
            left: `${s.position.x / page.width * 100}%`, top: `${s.position.y / page.height * 100}%`,
            width: `${s.width / page.width * 100}%`, height: `${s.height / page.height * 100}%`,
            fontSize: `${(s.fontSize ?? 8) * .3528 / page.width * 100}cqw`, lineHeight: s.lineHeight ?? 1.15,
          }
          const klass = `cp-paper-field${changed ? ' cp-hand' : aiChanged ? ' cp-ai' : ''}`
          if (repeated) return null
          if (layout.type === 'table' && target) {
            const entry = needText?.(target, field)
            if (entry) return <span key={s.name}>
              <PaperText field={entry} placeholder={field.endsWith('期間') ? printed.input[s.name] : undefined} className={klass} style={style} disabled={busy || readOnly} />
              {!readOnly && field === 'ニーズ' && previous?.needIndex !== target.needIndex &&
                <button className="cp-row-menu" type="button" disabled={busy} aria-label={`ニーズ${target.needIndex + 1}の行の操作`}
                  style={{ left: `${s.position.x / page.width * 100}%`, top: `${(s.position.y + s.height) / page.height * 100}%` }} onClick={open}>⋯</button>}
            </span>
          }
          if (isActivity && !readOnly) {
            const hour = (printed.input[s.name] ?? '').match(/^(\d{1,2}):00/)?.[1]
            const entry = hour === undefined ? undefined : activityText?.(hour)
            if (entry) return <div className="cp-paper-activity" style={style} key={s.name}>
              <span>{hour}:00</span><input aria-label={entry.label} value={entry.value} disabled={busy} onChange={e => entry.onChange(e.target.value)} />
            </div>
          }
          if (layout.type === 'timeline' && field === '週単位以外' && !readOnly && otherNotes?.length && index === 0) {
            return <div className="cp-paper-notes" style={style} key={s.name}>{otherNotes.map(entry =>
              <label key={entry.label}>{entry.label}<textarea value={entry.value} disabled={busy} onChange={e => entry.onChange(e.target.value)} /></label>
            )}</div>
          }
          return <button key={s.name} type="button" disabled={busy} className={`cp-paper-field${changed ? ' cp-hand' : aiChanged ? ' cp-ai' : ''}`}
            aria-label={`${field}（${action}）`}
            onClick={open} style={style}>{printed.input[s.name]}</button>
        })}
        {layout.type === 'table' && !readOnly && blankRow > 0 && blankRow < rowsPerPage
          && paperArea(layout.slots[0], '空いているニーズ欄', onNeeds, blankRow * layout.rowHeight)}
      </FormPage>
    </div>
  })}</div>
}
