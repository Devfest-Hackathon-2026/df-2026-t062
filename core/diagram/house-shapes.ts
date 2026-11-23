import { STEP_MARKER_SIZE } from './interaction.ts'
import type { Item } from './model.ts'

type Shape = Pick<Item, 'kind' | 'width' | 'height' | 'wallLine' | 'railLine'>

const ink = '#263c4b'
const selectedInk = '#684ac7'

/** Scale the same plan symbols for the drawing, palette and PDF. */
export function houseShape({ kind, width: w, height: h, wallLine, railLine }: Shape, selected = false): string {
  const accent = selected ? selectedInk : ink
  const stroke = Math.max(1.2, Math.min(w, h) * .04)
  switch (kind) {
    case 'wall':
      return wallLine
        ? `<line x1="0" y1="0" x2="${w}" y2="0" stroke="${accent}" stroke-width="6" stroke-linecap="round"/>`
        : `<rect width="${w}" height="${h}" fill="${ink}"/>`
    case 'step': {
      const x = w / 2, y = h / 2, half = STEP_MARKER_SIZE / 2
      return `<polygon points="${x},${y - half} ${x + half},${y + half} ${x - half},${y + half}" fill="${accent}"/>`
    }
    case 'room':
      return `<rect width="${w}" height="${h}" fill="#f6f4ee" stroke="${ink}" stroke-width="2"/>
        <rect x="4" y="4" width="${w - 8}" height="${h - 8}" fill="none" stroke="#cec6b6" stroke-width="1"/>`
    case 'door': {
      const left = w * .07, right = w * .93, top = h * .08, bottom = h * .92
      return `<path d="M${left} ${bottom} H${right}" stroke="white" stroke-width="8"/>
        <path d="M${left} ${bottom} H${right}" fill="none" stroke="#758895" stroke-width="2" stroke-dasharray="4 4"/>
        <path d="M${left} ${top} A${right - left} ${bottom - top} 0 0 1 ${right} ${bottom}" fill="none" stroke="#758895" stroke-width="2"/>
        <path d="M${left} ${bottom} V${top}" stroke="${ink}" stroke-width="${Math.min(stroke, 3)}" stroke-linecap="round"/>
        <circle cx="${left}" cy="${bottom}" r="3" fill="${ink}"/>`
    }
    case 'toilet':
      return `<g stroke="${ink}" stroke-width="${Math.min(stroke, 2.4)}">
        <ellipse cx="${w * .5}" cy="${h * .57}" rx="${w * .34}" ry="${h * .35}" fill="#fff"/>
        <ellipse cx="${w * .5}" cy="${h * .6}" rx="${w * .22}" ry="${h * .22}" fill="#dbeaf3"/>
        <rect x="${w * .12}" y="${h * .05}" width="${w * .76}" height="${h * .25}" rx="${Math.min(w, h) * .1}" fill="#fff"/>
        <circle cx="${w * .68}" cy="${h * .17}" r="${Math.min(w, h) * .04}" fill="#758895" stroke="none"/>
      </g>`
    case 'bathtub':
      return `<g stroke="${ink}" stroke-width="${Math.min(stroke, 2.4)}">
        <rect x="${w * .04}" y="${h * .06}" width="${w * .92}" height="${h * .88}" rx="${Math.min(w, h) * .17}" fill="#fff"/>
        <rect x="${w * .13}" y="${h * .19}" width="${w * .74}" height="${h * .62}" rx="${Math.min(w, h) * .26}" fill="#d7eee9"/>
        <circle cx="${w * .76}" cy="${h * .5}" r="${Math.min(w, h) * .06}" fill="#fff"/>
      </g>`
    case 'bed':
      return `<g stroke="${ink}" stroke-width="${Math.min(stroke, 2.5)}">
        <rect width="${w}" height="${h}" rx="${Math.min(w, h) * .08}" fill="#fff"/>
        <rect x="${w * .23}" y="${h * .12}" width="${w * .54}" height="${h * .21}" rx="${Math.min(w, h) * .07}" fill="#e8f0f7"/>
        <path d="M0 ${h * .43} H${w} V${h * .92} Q${w} ${h} ${w * .94} ${h} H${w * .06} Q0 ${h} 0 ${h * .92} Z" fill="#b9d2e7"/>
        <path d="M${w * .16} ${h * .53} H${w * .84}" stroke="#658aa6" stroke-linecap="round"/>
      </g>`
    case 'rail':
      if (railLine) {
        const color = selected ? selectedInk : '#387772'
        return `<line x1="0" y1="0" x2="${w}" y2="0" stroke="${color}" stroke-width="6" stroke-linecap="round"/>
          <circle cx="0" cy="0" r="5" fill="#fff" stroke="${color}" stroke-width="2"/>
          <circle cx="${w}" cy="0" r="5" fill="#fff" stroke="${color}" stroke-width="2"/>`
      }
      return `<g stroke-linecap="round">
        <path d="M${w * .2} ${h * .5} V${h * .72} M${w * .8} ${h * .5} V${h * .72}" fill="none" stroke="${ink}" stroke-width="${Math.min(h * .1, 5)}"/>
        <path d="M${w * .08} ${h * .44} H${w * .92}" fill="none" stroke="#387772" stroke-width="${Math.min(h * .15, 10)}"/>
        <path d="M${w * .2} ${h * .72} v0 M${w * .8} ${h * .72} v0" stroke="${ink}" stroke-width="${Math.min(h * .13, 7)}"/>
      </g>`
    case 'wheelchair':
      return `<g stroke="${ink}" stroke-width="${Math.min(stroke, 2.5)}">
        <rect x="${w * .07}" y="${h * .16}" width="${w * .14}" height="${h * .56}" rx="${w * .05}" fill="${ink}"/>
        <rect x="${w * .79}" y="${h * .16}" width="${w * .14}" height="${h * .56}" rx="${w * .05}" fill="${ink}"/>
        <rect x="${w * .25}" y="${h * .17}" width="${w * .5}" height="${h * .55}" rx="${Math.min(w, h) * .09}" fill="#b8c7df"/>
        <path d="M${w * .29} ${h * .25} H${w * .71}" stroke="#637492" stroke-linecap="round"/>
        <path d="M${w * .36} ${h * .72} V${h * .88} H${w * .44} M${w * .64} ${h * .72} V${h * .88} H${w * .56}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`
    case 'furniture':
      return `<g stroke="${ink}" stroke-width="${Math.min(stroke, 2.5)}">
        <rect width="${w}" height="${h}" rx="${Math.min(w, h) * .06}" fill="#e8d7bc"/>
        <path d="M${w / 2} 0 V${h} M${w * .38} ${h * .44} V${h * .59} M${w * .62} ${h * .44} V${h * .59}" fill="none" stroke-linecap="round"/>
      </g>`
    default:
      return `<rect width="${w}" height="${h}" fill="#fff" stroke="${ink}" stroke-width="2"/>`
  }
}
