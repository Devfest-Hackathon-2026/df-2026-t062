import { expandPrintLayout, type PrintPage } from '../../../core/print-layout.ts'
import type { FormDef, TemplateSlot } from '../../../core/form.ts'

/** 空欄の操作領域は画面専用。架空の行や予定を値・保存・PDFへ追加しない。 */
export function editablePages(form: FormDef, values: Record<string, unknown>): PrintPage[] {
  return expandPrintLayout(form, values, { checkOverflow: false }).filter(printed => {
    const layout = form.pages.find(p => p.pdfIndex === printed.sourceIndex)?.print
    // 第6・7表の補足明細は、空のときだけ画面から除く。値がある明細と原紙は残す。
    return !(['care_plan_6', 'care_plan_7'].includes(form.kind) && printed.sourceIndex > 0 && layout?.type === 'flow'
      && layout.slots.every(name => !(printed.input[name] ?? '').trim()))
  }).map(printed => {
    const layout = form.pages.find(p => p.pdfIndex === printed.sourceIndex)?.print
    const source = form.schemas[printed.sourceIndex]
    const empty: TemplateSlot[] = []
    if (layout?.type === 'table') {
      for (const name of layout.slots) {
        const slot = source.find(s => s.name === name)
        if (!slot) continue
        for (let row = 0; row < layout.rowsPerPage; row++) {
          const field = `${name}__row${row}`
          if (!printed.schemas.some(s => s.name === field)) empty.push({ ...slot, name: field, position: { x: slot.position.x, y: slot.position.y + row * layout.rowHeight } })
        }
      }
    } else if (layout?.type === 'timeline') {
      for (const name of [layout.slot, layout.activity?.slot]) {
        const slot = source.find(s => s.name === name)
        if (slot) empty.push({ ...slot, name: `${slot.name}__slot100000` })
      }
    } else if (layout?.type === 'flow') {
      // 年月日・項目は本文と同じ縦の欄。小さい印字領域とは別に空白部分も操作できる。
      const content = source.find(s => layout.slots.includes(s.name))
      if (content) for (const slot of source.filter(s => !layout.slots.includes(s.name) && s.position.y >= content.position.y && s.position.y < content.position.y + content.height)) {
        empty.push({ ...slot, name: `${slot.name}__empty`, position: { x: slot.position.x, y: content.position.y }, height: content.height })
      }
    }
    return { ...printed, schemas: [...empty, ...printed.schemas], input: { ...Object.fromEntries(empty.map(s => [s.name, ''])), ...printed.input } }
  })
}
