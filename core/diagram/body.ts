import { z } from 'zod'
export const anatomySchema = z.object({
  region: z.enum(['head', 'neck', 'shoulder', 'upper_arm', 'elbow', 'forearm', 'hand', 'chest', 'abdomen', 'back', 'lower_back', 'hip', 'thigh', 'knee', 'calf', 'ankle', 'foot', 'custom']),
  side: z.enum(['right', 'left', 'midline', 'unknown']),
  view: z.enum(['front', 'back']),
}).strict()
export type Anatomy = z.infer<typeof anatomySchema>
/** Anchors measured against the bundled 284×255 artwork. Right/left are the person's. */
const yOf: Record<Anatomy['region'], number> = { head: 84, neck: 102, shoulder: 111, upper_arm: 128, elbow: 141, forearm: 151, hand: 162, chest: 121, abdomen: 148, back: 132, lower_back: 151, hip: 164, thigh: 175, knee: 188, calf: 199, ankle: 213, foot: 222, custom: 0 }
const offsetOf: Record<Anatomy['region'], number> = { head: 8, neck: 4, shoulder: 14, upper_arm: 22, elbow: 29, forearm: 35, hand: 43, chest: 8, abdomen: 7, back: 8, lower_back: 7, hip: 8, thigh: 8, knee: 8, calf: 9, ankle: 11, foot: 16, custom: 0 }
const midlineRegions = new Set(['head', 'neck', 'chest', 'abdomen', 'back', 'lower_back'])
export function bodyAnchor(anatomy: Anatomy): { x: number, y: number } | null {
  if (anatomy.region === 'custom' || anatomy.side === 'unknown') return null
  if (anatomy.side === 'midline' && !midlineRegions.has(anatomy.region)) return null
  if (['back', 'lower_back'].includes(anatomy.region) && anatomy.view !== 'back') return null
  const center = anatomy.view === 'front' ? 63 : 170
  const rightSign = anatomy.view === 'front' ? -1 : 1
  const sign = anatomy.side === 'right' ? rightSign : anatomy.side === 'left' ? -rightSign : 0
  return { x: 97 + (center + sign * offsetOf[anatomy.region]) * 626 / 284, y: yOf[anatomy.region] * 560 / 255 }
}
/** Broad back descriptions are areas, never an invented single point. */
export function bodyPlacement(anatomy: Anatomy) {
  const anchor = bodyAnchor(anatomy)
  if (!anchor) return null
  if (anatomy.region === 'back' || anatomy.region === 'lower_back') {
    const width = anatomy.side === 'midline' ? 76 : 38, height = anatomy.region === 'back' ? 105 : 48
    return { x: anchor.x - width / 2, y: anchor.y - height / 2, width, height, rotation: 0, view: anatomy.view, range: 'area' as const }
  }
  return { x: anchor.x - 16, y: anchor.y - 22, width: 32, height: 52, rotation: 0, view: anatomy.view, range: 'point' as const }
}
export const BODY_VIEWS = { front: { x: 97, width: 260 }, back: { x: 357, width: 260 } } as const
export function tapPosition(view: 'front' | 'back', x: number, y: number) {
  const bounds = BODY_VIEWS[view]
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < bounds.x || x > bounds.x + bounds.width || y < 135 || y > 525) return null
  const px = (x - 97) * 284 / 626 - (view === 'front' ? 63 : 170), py = y * 255 / 560
  const head = (px / 15) ** 2 + ((py - 84) / 19) ** 2 <= 1
  const trunk = Math.abs(px) <= 18 && py >= 103 && py <= 164
  const arms = py >= 105 && py <= 166 && Math.abs(Math.abs(px) - (14 + (py - 110) * .55)) <= 9
  const legs = py >= 158 && py <= 229 && Math.abs(Math.abs(px) - (7 + (py - 160) * .12)) <= 8
  if (!head && !trunk && !arms && !legs) return null
  return { x: x - 16, y: y - 22, width: 32, height: 52, rotation: 0, view }
}

export function normalizeBodyProposal(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const envelope = value as Record<string, unknown>
  if (envelope.kind !== 'body' || !envelope.data || typeof envelope.data !== 'object') return value
  const data = envelope.data as Record<string, unknown>
  if (!Array.isArray(data.items)) return value
  return { ...envelope, data: { ...data, items: data.items.map((item: unknown) => {
    if (!item || typeof item !== 'object') return item
    const raw = item as Record<string, unknown>, anatomy = anatomySchema.safeParse(raw.anatomy)
    const placement = anatomy.success && bodyPlacement(anatomy.data)
    return placement ? { ...raw, ...placement } : item
  }) } }
}

export function bodyPartLabel(anatomy: Anatomy): string {
  const labels: Record<Anatomy['region'], string> = { head: '頭部', neck: '首', shoulder: '肩', upper_arm: '上腕', elbow: '肘', forearm: '前腕', hand: '手', chest: '胸', abdomen: '腹部', back: '背中', lower_back: '腰', hip: '股関節', thigh: '太もも', knee: '膝', calf: 'ふくらはぎ', ankle: '足首', foot: '足', custom: '図で指定した位置' }
  const side = anatomy.side === 'right' ? '本人の右・' : anatomy.side === 'left' ? '本人の左・' : ''
  return `${side}${labels[anatomy.region]}（${anatomy.view === 'front' ? '正面' : '背面'}）`
}
