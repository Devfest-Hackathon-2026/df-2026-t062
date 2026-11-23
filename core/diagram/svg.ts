import { houseShape } from './house-shapes.ts'
import { resizeCorners } from './interaction.ts'
import { familyLayout, familyRelationPaths, livesInHousehold } from './family-layout.ts'
import { BODY_VIEWS } from './body.ts'
import { type Doc, type Tab, type Item } from './model.ts'

const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
const text = (x: number, y: number, label: unknown, size = 20, color = '#172b3d') => `<text x="${x}" y="${y}" text-anchor="middle" font-size="${size}" fill="${color}">${escape(label)}</text>`
const LABEL_SIZE = 17, LINE = 22
const labelBase = (i: Item) => i.y + (i.range === 'area' ? i.height + 18 : 57) + (i.labelOffsetY ?? 0)
/** Line index per body label: a label moves down until its estimated box clears every earlier label in the same view (#198). */
export function bodyLabelLines(items: readonly Item[]): Map<string, number> {
  const placed: { view: unknown, cx: number, half: number, y: number }[] = [], lines = new Map<string, number>()
  for (const i of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const cx = i.x + i.width / 2, half = String(i.label ?? '').length * LABEL_SIZE / 2
    let line = 0
    while (placed.some((p) => p.view === i.view && Math.abs(p.cx - cx) < p.half + half && Math.abs(p.y - (labelBase(i) + line * LINE)) < LINE)) line++
    lines.set(i.id, line)
    placed.push({ view: i.view, cx, half, y: labelBase(i) + line * LINE })
  }
  return lines
}
/** One ordering rule for preview, editing, hit testing and export. */
export function roomsBehind(items: readonly Item[]): Item[] { return [...items.filter((i) => i.kind === 'room'), ...items.filter((i) => i.kind !== 'room')] }
export function diagramSvg(doc: Doc, tab: Tab, options: { editing?: boolean, cropBody?: boolean, bodyImage?: string, selected?: string, bodyView?: 'front' | 'back' } = {}): string {
  let contents = '', viewBox = '0 0 820 560'
  if (tab === 'family') {
    const people = familyLayout(doc.family)
    const minX = Math.min(0, ...people.map((p) => p.x - 55))
    const maxX = Math.max(820, ...people.map((p) => p.x + 160)), maxY = Math.max(560, ...people.map((p) => p.y + 135))
    const together = people.filter(livesInHousehold)
    if (together.length) {
      const x = Math.min(...together.map((p) => p.x)), y = Math.min(...together.map((p) => p.y))
      contents += `<rect x="${x - 14}" y="${y - 8}" width="${Math.max(...together.map((p) => p.x)) - x + 148}" height="${Math.max(...together.map((p) => p.y)) - y + 130}" fill="none" stroke="#344757" stroke-dasharray="8 5"/>${text(x + 20, y - 15, '同居')}`
    }
    const { paths, right } = familyRelationPaths(people, doc.family.relations, maxX)
    for (const { path, divorceMark } of paths) {
      contents += `<path d="${path}" fill="none" stroke="white" stroke-width="5"/><path d="${path}" fill="none" stroke="#172b3d" stroke-width="2"/>`
      if (divorceMark) contents += text(divorceMark.x, divorceMark.y + 6, '//', 17)
    }
    viewBox = `${minX} 0 ${right + 20 - minX} ${maxY + 70}`
    for (const p of people) {
      const fill = p.deceased ? '#172b3d' : 'white'
      const shape = p.sex === 'female' ? `<circle r="27" fill="${fill}"/>${p.isSubject ? '<circle r="21" fill="none"/>' : ''}` : p.sex === 'male' ? `<rect x="-27" y="-27" width="54" height="54" fill="${fill}"/>${p.isSubject ? '<rect x="-21" y="-21" width="42" height="42" fill="none"/>' : ''}` : `<path d="M0 -28 L28 0 L0 28 L-28 0Z" fill="${fill}"/>${p.isSubject ? '<path d="M0 -21 L21 0 L0 21 L-21 0Z" fill="none"/>' : ''}`
      const household = p.deceased === true ? '' : p.household === '不明' ? '同居未確認' : p.household === '別居' ? '別居' : ''
      const life = p.deceased === null ? '生死未確認' : p.deceased ? '' : '生存'
      contents += `<g data-person-id="${escape(p.id)}" transform="translate(${p.x + 60},${p.y + 32})" stroke="#172b3d" stroke-width="3">${options.editing ? '<rect x="-60" y="-32" width="120" height="120" fill="transparent" stroke="none"/>' : ''}${shape}<g stroke="none">${text(0, 60, `${p.name || '名前未確認'}${p.age == null ? '' : `（${p.age}歳）`}`)}${text(0, 83, [p.isSubject ? '本人' : '', household, life].filter(Boolean).join('・'), 14)}</g></g>`
      if (p.id === options.selected) contents += `<rect x="${p.x}" y="${p.y}" width="120" height="110" fill="none" stroke="#684ac7" stroke-width="3" stroke-dasharray="6 3" pointer-events="none"/>`
    }
    contents += text(410, maxY + 48, '女性 ○　男性 □　本人 二重枠　死亡 塗りつぶし　同居 破線囲み', 18)
  } else {
    if (tab === 'body') {
      if (options.cropBody) viewBox = '97 0 626 560'
      if (options.bodyView) viewBox = `${BODY_VIEWS[options.bodyView].x} 0 ${BODY_VIEWS[options.bodyView].width} 560`
      contents += `<image href="${escape(options.bodyImage ?? '/diagrams/body.png')}" x="97" y="0" width="626" height="560" preserveAspectRatio="xMidYMid meet"/>`
    } else if (doc.house.background) contents += `<image href="${escape(doc.house.background)}" width="820" height="560" preserveAspectRatio="xMidYMid meet"/>`
    else if (options.editing) {
      for (let x = 0; x < 820; x += 32) contents += `<path d="M${x} 0 V560" stroke="#e0e6e8"/>`
      for (let y = 0; y < 560; y += 32) contents += `<path d="M0 ${y} H820" stroke="#e0e6e8"/>`
    }
    let resizeHandles = ''
    const bodyLines = bodyLabelLines(doc.body.items)
    for (const i of tab === 'house' ? roomsBehind(doc.house.items) : doc.body.items.filter((i) => !options.bodyView || i.view === options.bodyView)) {
      let shape: string
      if (tab === 'body') {
        const marks: Partial<Record<Item['kind'], string>> = { disability: '△', loss: '×', pressure: '●', pain: '※', paralysis: '△', contracture: '△', note: '※' }
        shape = `${i.range === 'area' ? `<rect width="${i.width}" height="${i.height}" fill="none" stroke="#172b3d" stroke-width="2" stroke-dasharray="5 3"/>` : ''}${text(i.width / 2, i.range === 'area' ? i.height / 2 + 10 : 35, marks[i.kind] ?? '●', 38, '#111')}${text(i.width / 2, (i.range === 'area' ? i.height + 18 : 57) + (i.labelOffsetY ?? 0) + (bodyLines.get(i.id) ?? 0) * 22, i.label, 17)}`
      } else {
        shape = houseShape(i, options.editing && i.id === options.selected)
        if (!options.editing && i.kind !== 'step' && !i.wallLine && !i.railLine) {
          const fixture = i.kind === 'door' || i.kind === 'toilet' || i.kind === 'bathtub'
          const labelY = fixture ? i.height + 15 : i.kind === 'bed' ? i.height * .8 : i.kind === 'rail' || i.kind === 'wheelchair' || i.kind === 'furniture' ? i.height * .89 : 24
          shape += text(i.width / 2, labelY, i.label, fixture ? 14 : 19, i.kind === 'wall' ? 'white' : '#172b3d')
        }
      }
      const box = !i.wallLine && !i.railLine && (tab !== 'house' || i.kind !== 'step')
      if (tab === 'house' && options.editing && i.id === options.selected && (i.wallLine || i.railLine)) {
        resizeHandles = `<g aria-hidden="true" transform="translate(${i.x},${i.y}) rotate(${i.rotation})">${(['start', 'end'] as const).map((endpoint) => {
          const x = endpoint === 'start' ? 0 : i.width
          return `<g data-line-endpoint="${endpoint}"><circle cx="${x}" cy="0" r="18" fill="transparent"/><circle cx="${x}" cy="0" r="7" fill="#fff" stroke="#684ac7" stroke-width="2" vector-effect="non-scaling-stroke"/></g>`
        }).join('')}</g>`
      } else if (tab === 'house' && options.editing && box && i.id === options.selected) {
        resizeHandles = `<g aria-hidden="true" transform="translate(${i.x},${i.y}) rotate(${i.rotation})">${resizeCorners.map((corner) => {
          const x = corner.endsWith('w') ? 0 : i.width
          const y = corner.startsWith('n') ? 0 : i.height
          return `<g data-resize-corner="${corner}"><circle cx="${x}" cy="${y}" r="16" fill="transparent"/><circle cx="${x}" cy="${y}" r="6" fill="#fff" stroke="#684ac7" stroke-width="2" vector-effect="non-scaling-stroke"/></g>`
        }).join('')}</g>`
      }
      contents += `<g data-object-id="${escape(i.id)}" transform="translate(${i.x},${i.y}) rotate(${i.rotation})">${shape}${box && i.id === options.selected ? `<rect width="${i.width}" height="${i.height}" fill="none" stroke="#684ac7" stroke-width="3" stroke-dasharray="6 3"/>` : ''}</g>`
    }
    contents += resizeHandles
  }
  if (tab === 'body') contents += text(options.bodyView ? BODY_VIEWS[options.bodyView].x + BODY_VIEWS[options.bodyView].width / 2 : 410, 550, '※ 本人の訴え・注記', 14)
  const [, , width, height] = viewBox.split(' ').map(Number)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${tab === 'family' ? '家族構成図' : tab === 'house' ? '家屋見取図' : '人体図'}の入力内容" style="font-family:BIZUDPGothic,sans-serif"><rect x="-1000" y="-1000" width="${Math.max(4000, width + 2000)}" height="${Math.max(4000, height + 2000)}" fill="white"/>${contents}</svg>`
}
