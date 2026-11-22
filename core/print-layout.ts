// 公式様式の表・時間軸の展開。画面とPDFで共用し、様式の版の pages[].print 宣言を使う。
import { renderAll, type Values } from './binding.ts'
import type { FormPage, TemplateSlot } from './form.ts'

export interface PrintPage {
  sourceIndex: number
  schemas: TemplateSlot[]
  input: Record<string, string>
}

/** 読める最小文字サイズでも印字領域に収まらない。値そのものはエラーに含めない。 */
export class PdfOverflow extends Error {
  slots: string[]
  constructor(slots: string[]) {
    super('印字欄に収まらない文章があります')
    this.slots = slots
  }
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

/** 子が空でも親のニーズ・目標を落とさない。1つの葉を元と同じ入れ子の形で返す。 */
function leaves(value: unknown, nested: string[]): unknown[] {
  const rows = Array.isArray(value) && value.length ? value : [{}]
  if (!nested.length) return rows
  const [key, ...rest] = nested
  return rows.flatMap((row) => leaves(record(row)[key], rest).map((child) => ({ ...record(row), [key]: [child] })))
}

export function expandPrintLayout(
  form: { schemas: TemplateSlot[][], pages: FormPage[], bindings: Parameters<typeof renderAll>[0] },
  values: Values,
  options: { checkOverflow?: boolean } = {},
): PrintPage[] {
  const rendered = renderAll(form.bindings, values)
  const expanded = form.schemas.flatMap((schemas, sourceIndex): PrintPage[] => {
    const layout = form.pages.find((p) => p.pdfIndex === sourceIndex)?.print
    if (!layout || layout.type === 'text') return [{ sourceIndex, schemas, input: rendered }]
    if (layout.type === 'sections') {
      const regions = layout.slots.map(n => schemas.find(s => s.name === n))
      if (!regions.length || regions.some(s => !s || s.type !== 'text')) throw new Error('文章の継続領域が不正です')
      const parts = regions.map(s => textChunks(rendered[s!.name] ?? '', s!))
      const rows = layout.list && Array.isArray(values[layout.list.key]) ? values[layout.list.key] as unknown[] : []
      if (layout.list && (!Number.isInteger(layout.list.rowsPerPage) || layout.list.rowsPerPage < 1)) throw new Error('継続する表の行数が不正です')
      const count = Math.max(1, ...parts.map(p => p.length), layout.list ? Math.ceil(rows.length / layout.list.rowsPerPage) : 0)
      return Array.from({ length: count }, (_, n) => ({
        sourceIndex, schemas,
        input: { ...(layout.list ? renderAll(form.bindings, { ...values, [layout.list.key]: rows.slice(n * layout.list.rowsPerPage, (n + 1) * layout.list.rowsPerPage) }) : rendered), ...Object.fromEntries(regions.map((s, i) => [s!.name, parts[i][n] ?? ''])) },
      }))
    }
    if (layout.type === 'flow') {
      const regions = layout.slots.map(name => schemas.find(s => s.name === name))
      if (!regions.length || regions.some(s => !s || s.type !== 'text')) throw new Error('文章の継続領域が不正です')
      const first = regions[0]!
      if (regions.some(s => s!.width !== first.width || s!.height !== first.height || s!.fontSize !== first.fontSize || s!.lineHeight !== first.lineHeight || s!.dynamicFontSize?.min !== first.dynamicFontSize?.min)) throw new Error('文章の継続領域の寸法が一致しません')
      const parts = textChunks(rendered[first.name] ?? '', first)
      return Array.from({ length: Math.ceil(parts.length / regions.length) }, (_, n) => ({
        sourceIndex, schemas, input: { ...rendered, ...Object.fromEntries(regions.map((s, i) => [s!.name, parts[n * regions.length + i] ?? ''])) },
      }))
    }
    if (layout.type === 'table') {
      const rows = leaves(values[layout.key], layout.nested)
      const names = new Set(layout.slots)
      const pages: PrintPage[] = []
      if (!Number.isInteger(layout.rowsPerPage) || layout.rowsPerPage < 1 || layout.rowHeight <= 0) throw new Error('印字の表の設定が不正です')
      for (let offset = 0; offset < rows.length; offset += layout.rowsPerPage) {
        const page: PrintPage = { sourceIndex, schemas: schemas.filter((s) => !names.has(s.name)), input: { ...rendered } }
        for (const [i, row] of rows.slice(offset, offset + layout.rowsPerPage).entries()) {
          const rowValues = renderAll(form.bindings, { ...values, [layout.key]: [row] })
          for (const slot of schemas.filter((s) => names.has(s.name))) {
            const name = `${slot.name}__row${i}`
            page.schemas.push({ ...slot, name, position: { x: slot.position.x, y: slot.position.y + i * layout.rowHeight } })
            page.input[name] = rowValues[slot.name]
          }
        }
        pages.push(page)
      }
      return pages
    }
    const area = schemas.find((s) => s.name === layout.slot)
    if (!area) throw new Error('時間軸の印字領域がありません')
    const activityArea = layout.activity ? schemas.find((s) => s.name === layout.activity!.slot) : undefined
    const base = () => ({ sourceIndex, schemas: schemas.filter((s) => s.name !== layout.slot && s.name !== layout.activity?.slot), input: { ...rendered } })
    const pages: PrintPage[] = [base()]
    const occupied: { day: number, top: number, bottom: number }[][] = [[]]
    const time = (value: unknown) => {
      if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('保存済み時間枠の時刻が不正です')
      return Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
    }
    const slots = Array.isArray(values[layout.key]) ? values[layout.key] as unknown[] : []
    const parts: { day: number, start: number, end: number, label: string, activity?: boolean }[] = []
    for (const value of slots) {
      const row = record(value)
      const day = layout.days.indexOf(String(row[layout.dayField]))
      if (day < 0) throw new Error('保存済み時間枠の曜日が不正です')
      const start = time(row[layout.startField])
      const end = time(row[layout.endField])
      const label = `${String(row[layout.startField])}–${end < start ? '\n翌' : ''}${String(row[layout.endField])}\n${String(row[layout.labelField] ?? '')}`
      if (end < start) {
        parts.push({ day, start, end: 1440, label }, { day: (day + 1) % layout.days.length, start: 0, end, label: `前日から\n${label}` })
      } else parts.push({ day, start, end, label })
    }
    if (layout.activity && activityArea) {
      const config = layout.activity
      const rows = values[config.key]
      for (const value of Array.isArray(rows) ? rows : []) {
        const row = record(value)
        if (!row[config.labelField]) continue
        const hour = Number(row[config.timeField])
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('保存済み生活時間が不正です')
        parts.push({ day: layout.days.length, start: hour * 60, end: hour * 60 + 60, label: `${hour}:00 ${String(row[config.labelField])}`, activity: true })
      }
    }
    // 短時間・同時提供で文字が重なるときは、公式の同じ用紙を増やして省略せず印字する。
    for (const [index, part] of parts.entries()) {
      const region = part.activity ? activityArea! : area
      const height = Math.max(part.activity ? 6 : 12, (part.end - part.start) / 1440 * region.height)
      const top = Math.min(region.height - height, part.start / 1440 * region.height)
      let pageIndex = occupied.findIndex((boxes) => boxes.every((b) => b.day !== part.day || b.bottom <= top || b.top >= top + height))
      if (pageIndex < 0) {
        pageIndex = pages.length
        pages.push(base())
        occupied.push([])
      }
      const width = part.activity ? region.width : region.width / layout.days.length
      const name = `${region.name}__slot${index}`
      pages[pageIndex].schemas.push({
        ...region, name, position: { x: region.position.x + (part.activity ? 0 : part.day * width) + 0.5, y: region.position.y + top },
        width: width - 1, height, fontSize: 7, dynamicFontSize: { min: 6, max: 7, fit: 'both' },
      })
      pages[pageIndex].input[name] = part.label
      occupied[pageIndex].push({ day: part.day, top, bottom: top + height })
    }
    return pages
  })
  const checked = expanded.flatMap((page) => {
    if (options.checkOverflow === false) return [page]
    if (!form.pages.find((p) => p.pdfIndex === page.sourceIndex)?.print) return [page]
    // 最小6pt・1文字1emの保守的な上限で折り返す。縮小しきれない長文は422にし、切り捨てない。
    const chunks = new Map(page.schemas.filter((s) => s.type === 'text').map((slot) => [
      slot.name, textChunks(page.input[slot.name] ?? '', slot),
    ]))
    const overflow = [...chunks].filter(([, parts]) => parts.length > 1).map(([name]) => name)
    if (overflow.length) throw new PdfOverflow(overflow)
    return [{ ...page, input: { ...page.input, ...Object.fromEntries([...chunks].map(([name, parts]) => [name, parts[0]])) } }]
  })
  const counters = new Map<number, number>()
  return checked.map((page) => {
    const formPage = form.pages.find((p) => p.pdfIndex === page.sourceIndex)
    const count = checked.filter((p) => p.sourceIndex === page.sourceIndex).length
    if (!formPage?.print || count < 2) return page
    const number = (counters.get(page.sourceIndex) ?? 0) + 1
    counters.set(page.sourceIndex, number)
    return {
      ...page,
      schemas: [...page.schemas, {
        name: '__continuation_page', type: 'text', position: { x: formPage.width - 27, y: formPage.height - 5 },
        width: 20, height: 3, fontSize: 6, fontName: 'BIZUDPGothic', alignment: 'right',
      } satisfies TemplateSlot],
      input: { ...page.input, __continuation_page: `${number}/${count}` },
    }
  })
}

function textChunks(text: string, slot: TemplateSlot): string[] {
  const font = slot.dynamicFontSize?.min ?? slot.fontSize ?? 8
  const charWidth = font * 25.4 / 72
  const cols = Math.max(1, Math.floor((slot.width - 1) / charWidth))
  const linesPerPage = Math.max(1, Math.floor((slot.height - 0.8) / (charWidth * (slot.lineHeight ?? 1.15))))
  const lines = text.split('\n').flatMap((line) => {
    const chars = Array.from(line)
    if (!chars.length) return ['']
    return Array.from({ length: Math.ceil(chars.length / cols) }, (_, i) => chars.slice(i * cols, (i + 1) * cols).join(''))
  })
  return Array.from({ length: Math.max(1, Math.ceil(lines.length / linesPerPage)) }, (_, i) => lines.slice(i * linesPerPage, (i + 1) * linesPerPage).join('\n'))
}
