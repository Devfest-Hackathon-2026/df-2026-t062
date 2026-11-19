import { type Doc, type Tab, type Item } from './model.ts'

const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
const text = (x: number, y: number, label: unknown, size = 20, color = '#172b3d') => `<text x="${x}" y="${y}" text-anchor="middle" font-size="${size}" fill="${color}">${escape(label)}</text>`
/** One ordering rule for preview, editing, hit testing and export. */
export function roomsBehind(items: readonly Item[]): Item[] { return [...items.filter((i) => i.kind === 'room'), ...items.filter((i) => i.kind !== 'room')] }
export function diagramSvg(doc: Doc, tab: Tab, options: { editing?: boolean, cropBody?: boolean, bodyImage?: string, selected?: string } = {}): string {
  let contents = '', viewBox = '0 0 820 560'
  if (tab === 'family') {
    const people = doc.family.people
    const minX = Math.min(0, ...people.map((p) => p.x - 55)), minY = Math.min(0, ...people.map((p) => p.y - 55))
    const maxX = Math.max(820, ...people.map((p) => p.x + 160)), maxY = Math.max(560, ...people.map((p) => p.y + 135))
    viewBox = options.editing ? '0 0 820 630' : `${minX} ${minY} ${maxX - minX} ${maxY + 70 - minY}`
    const together = people.filter((p) => p.household === '同居')
    if (together.length) {
      const x = Math.min(...together.map((p) => p.x)), y = Math.min(...together.map((p) => p.y))
      contents += `<rect x="${x - 14}" y="${y - 8}" width="${Math.max(...together.map((p) => p.x)) - x + 148}" height="${Math.max(...together.map((p) => p.y)) - y + 130}" fill="none" stroke="#344757" stroke-dasharray="8 5"/>${text(x + 20, y - 15, '同居')}`
    }
    for (const r of doc.family.relations) {
      const a = people.find((p) => p.id === r.source)!, b = people.find((p) => p.id === r.target)!
      const x = a.x + 60, y = a.y + 32, xx = b.x + 60, yy = b.y + 32
      contents += `<path d="${r.kind === '親子' ? `M${x} ${y} V${(y + yy) / 2} H${xx} V${yy}` : `M${x} ${y} L${xx} ${yy}`}" fill="none" stroke="#172b3d" stroke-width="3"/>`
      if (r.kind === '離婚') contents += text((x + xx) / 2, (y + yy) / 2 + 8, '//', 32)
    }
    for (const p of people) {
      const fill = p.deceased ? '#172b3d' : 'white'
      const shape = p.sex === 'female' ? `<circle r="27" fill="${fill}"/>${p.isSubject ? '<circle r="21" fill="none"/>' : ''}` : p.sex === 'male' ? `<rect x="-27" y="-27" width="54" height="54" fill="${fill}"/>${p.isSubject ? '<rect x="-21" y="-21" width="42" height="42" fill="none"/>' : ''}` : `<path d="M0 -28 L28 0 L0 28 L-28 0Z" fill="${fill}"/>${p.isSubject ? '<path d="M0 -21 L21 0 L0 21 L-21 0Z" fill="none"/>' : ''}`
      contents += `<g transform="translate(${p.x + 60},${p.y + 32})" stroke="#172b3d" stroke-width="3">${shape}<g stroke="none">${text(0, 60, `${p.name || '名前未入力'}${p.age == null ? '' : `（${p.age}歳）`}`)}${p.isSubject ? text(0, 83, '本人', 17) : ''}</g></g>`
      if (p.id === options.selected) contents += `<rect x="${p.x}" y="${p.y}" width="120" height="110" fill="none" stroke="#684ac7" stroke-width="3" stroke-dasharray="6 3"/>`
    }
    contents += text(410, maxY + 48, '女性 ○　男性 □　本人 二重枠　死亡 塗りつぶし　同居 破線囲み', 18)
  } else {
    if (tab === 'body') {
      if (options.cropBody) viewBox = '97 0 626 560'
      contents += `<image href="${escape(options.bodyImage ?? '/diagrams/body.png')}" x="97" y="0" width="626" height="560" preserveAspectRatio="xMidYMid meet"/>`
    } else if (doc.house.background) contents += `<image href="${escape(doc.house.background)}" width="820" height="560" preserveAspectRatio="xMidYMid meet"/>`
    else if (options.editing) {
      for (let x = 0; x < 820; x += 32) contents += `<path d="M${x} 0 V560" stroke="#e0e6e8"/>`
      for (let y = 0; y < 560; y += 32) contents += `<path d="M0 ${y} H820" stroke="#e0e6e8"/>`
    }
    for (const i of tab === 'house' ? roomsBehind(doc.house.items) : doc.body.items) {
      let shape: string
      if (tab === 'body') {
        const marks: Partial<Record<Item['kind'], string>> = { disability: '△', loss: '×', pressure: '●', pain: '△', paralysis: '△', contracture: '△', note: '' }
        shape = `${i.range === 'area' ? `<rect width="${i.width}" height="${i.height}" fill="none" stroke="#172b3d" stroke-width="2" stroke-dasharray="5 3"/>` : ''}${text(i.width / 2, 35, marks[i.kind] ?? '●', 38, '#111')}${text(i.width / 2, 57 + (i.labelOffsetY ?? 0), i.label, 17)}`
      } else {
        shape = `<rect width="${i.width}" height="${i.height}" fill="${i.kind === 'room' ? '#f8fafb' : i.kind === 'wall' ? '#25394a' : i.kind === 'rail' ? '#dbe7f2' : '#fff'}" stroke="#25394a" stroke-width="2"/>`
        if (i.kind === 'bed') shape += `<rect x="7" y="7" width="${i.width - 14}" height="${Math.min(30, i.height / 3)}" fill="#edf3f7" stroke="#25394a"/>`
        if (i.kind === 'step') shape += text(i.width / 2, 28, '▲', 26)
        shape += text(i.width / 2, i.kind === 'bed' ? i.height / 2 : i.kind === 'step' ? 51 : 24, i.kind === 'step' && i.stepHeightCm != null ? `段差 ${i.stepHeightCm}cm` : i.label, 19, i.kind === 'wall' ? 'white' : '#172b3d')
      }
      contents += `<g data-object-id="${escape(i.id)}" transform="translate(${i.x},${i.y}) rotate(${i.rotation})">${shape}${i.id === options.selected ? `<rect width="${i.width}" height="${i.height}" fill="none" stroke="#684ac7" stroke-width="3" stroke-dasharray="6 3"/>` : ''}</g>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${tab === 'family' ? '家族構成図' : tab === 'house' ? '家屋見取図' : '人体図'}の入力内容" style="font-family:BIZUDPGothic,sans-serif"><rect x="-1000" y="-1000" width="4000" height="4000" fill="white"/>${contents}</svg>`
}
