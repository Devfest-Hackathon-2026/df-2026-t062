import type { Item, Person } from './model.ts'

export const STEP_MARKER_SIZE = 36
/** The browser supplies the SVG screen matrix, including zoom and letterboxing. */
export function drawingPoint(point: { x: number, y: number }, matrix: { a: number, b: number, c: number, d: number, e: number, f: number }, allowOutside = false): { x: number, y: number } | null {
  const { a, b, c, d, e, f } = matrix
  const det = a * d - b * c
  if (!Number.isFinite(det) || det === 0) return null
  const x = (d * (point.x - e) - c * (point.y - f)) / det
  const y = (-b * (point.x - e) + a * (point.y - f)) / det
  return Number.isFinite(x) && Number.isFinite(y) && (allowOutside || (x >= 0 && x <= 820 && y >= 0 && y <= 560)) ? { x, y } : null
}
export function contains(object: Item | Person, point: { x: number, y: number }): boolean {
  const r = ('rotation' in object ? object.rotation : 0) * Math.PI / 180
  const dx = point.x - object.x, dy = point.y - object.y
  const x = dx * Math.cos(r) + dy * Math.sin(r), y = -dx * Math.sin(r) + dy * Math.cos(r)
  if ('kind' in object && object.kind === 'step') {
    const half = STEP_MARKER_SIZE / 2
    return Math.abs(x - object.width / 2) <= half && Math.abs(y - object.height / 2) <= half
  }
  if ('kind' in object && (object.wallLine || object.railLine)) return x >= -8 && x <= object.width + 8 && Math.abs(y) <= 10
  return x >= 0 && y >= 0 && x <= ('width' in object ? object.width : 120) && y <= ('height' in object ? object.height : 110)
}

export const resizeCorners = ['nw', 'ne', 'se', 'sw'] as const
export type ResizeCorner = typeof resizeCorners[number]
type Point = { x: number, y: number }
type Box = Pick<Item, 'x' | 'y' | 'width' | 'height'>

export function resizeItem(item: Box & Pick<Item, 'rotation'>, corner: ResizeCorner, delta: Point): Box {
  const west = corner.endsWith('w')
  const north = corner.startsWith('n')
  const radians = item.rotation * Math.PI / 180
  const cos = Math.cos(radians), sin = Math.sin(radians)
  const localX = delta.x * cos + delta.y * sin
  const localY = -delta.x * sin + delta.y * cos
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  if (item.rotation % 360 === 0) {
    const right = item.x + item.width
    const bottom = item.y + item.height
    const width = clamp(item.width + (west ? -localX : localX), 20, Math.min(820, west ? right : 820 - item.x))
    const height = clamp(item.height + (north ? -localY : localY), 20, Math.min(560, north ? bottom : 560 - item.y))
    return { x: west ? right - width : item.x, y: north ? bottom - height : item.y, width, height }
  }
  const width = clamp(item.width + (west ? -localX : localX), 20, 820)
  const height = clamp(item.height + (north ? -localY : localY), 20, 560)
  const left = west ? item.width - width : 0
  const top = north ? item.height - height : 0

  // Keep the opposite corner fixed. Shorten the drag where a corner hits the canvas.
  // Legacy items already crossing an edge can move back in without jumping on pointer down.
  let progress = 1
  const epsilon = 1e-8
  for (const x of [0, 1]) {
    for (const y of [0, 1]) {
      const startX = item.x + x * item.width * cos - y * item.height * sin
      const startY = item.y + x * item.width * sin + y * item.height * cos
      const dx = left + x * (width - item.width)
      const dy = top + y * (height - item.height)
      const moveX = dx * cos - dy * sin
      const moveY = dx * sin + dy * cos
      if (moveX > epsilon) progress = Math.min(progress, Math.max(0, 820 - startX) / moveX)
      if (moveX < -epsilon) progress = Math.min(progress, Math.max(0, startX) / -moveX)
      if (moveY > epsilon) progress = Math.min(progress, Math.max(0, 560 - startY) / moveY)
      if (moveY < -epsilon) progress = Math.min(progress, Math.max(0, startY) / -moveY)
    }
  }
  return {
    x: clamp(item.x + (left * cos - top * sin) * progress, 0, 820),
    y: clamp(item.y + (left * sin + top * cos) * progress, 0, 560),
    width: clamp(item.width + (width - item.width) * progress, 20, 820),
    height: clamp(item.height + (height - item.height) * progress, 20, 560),
  }
}

export function lineGeometry(start: Point, target: Point) {
  const dx = target.x - start.x, dy = target.y - start.y
  const step = Math.PI / 4
  const direction = Math.round(Math.atan2(dy, dx) / step)
  const radians = direction * step
  const unitX = Math.abs(direction) % 4 === 2 ? 0 : Math.cos(radians)
  const unitY = direction % 4 === 0 ? 0 : Math.sin(radians)
  const maxLength = (origin: number, unit: number, limit: number) =>
    unit > 0 ? (limit - origin) / unit : unit < 0 ? -origin / unit : Infinity
  // Project the pointer onto the snapped direction, then stop at the first canvas edge.
  const width = Math.max(0, Math.min(dx * unitX + dy * unitY, maxLength(start.x, unitX, 820), maxLength(start.y, unitY, 560)))
  return {
    geometry: { ...start, width, height: 20, rotation: direction * 45 },
    end: { x: start.x + unitX * width, y: start.y + unitY * width },
  }
}

export type LineEndpoint = 'start' | 'end'

export function lineEnd({ x, y, width, rotation }: Pick<Item, 'x' | 'y' | 'width' | 'rotation'>): Point {
  const angle = rotation * Math.PI / 180
  return { x: x + width * Math.cos(angle), y: y + width * Math.sin(angle) }
}

export function resizeLine(item: Item, endpoint: LineEndpoint, delta: Point) {
  const start = { x: item.x, y: item.y }
  const end = lineEnd(item)
  const fixed = endpoint === 'start' ? end : start
  const moving = endpoint === 'start' ? start : end
  const { geometry, end: snapped } = lineGeometry(fixed, { x: moving.x + delta.x, y: moving.y + delta.y })
  if (geometry.width < 2) return
  if (endpoint === 'end') return geometry
  // Reorient the new segment so that its stored end remains at the fixed point.
  return {
    ...geometry,
    x: Math.max(0, Math.min(820, snapped.x)),
    y: Math.max(0, Math.min(560, snapped.y)),
    rotation: (geometry.rotation + 180) % 360,
  }
}

/** Bounds relative to the SVG origin. A drawn line has two endpoints and no box height. */
function itemBounds(item: Item, rotation: number) {
  const radians = rotation * Math.PI / 180
  const cos = Math.cos(radians), sin = Math.sin(radians)
  const height = item.wallLine || item.railLine ? 0 : item.height
  const xs = [0, item.width * cos, -height * sin, item.width * cos - height * sin]
  const ys = [0, item.width * sin, height * cos, item.width * sin + height * cos]
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
}

export function moveHouseItem(item: Item, delta: Point): Point {
  const bounds = itemBounds(item, item.rotation)
  const clampAxis = (value: number, min: number, max: number, limit: number) =>
    Math.max(0, Math.min(limit, min > max + 1e-8 ? value : Math.max(min, Math.min(max, value))))
  return {
    x: clampAxis(item.x + delta.x, -bounds.left, 820 - bounds.right, 820),
    y: clampAxis(item.y + delta.y, -bounds.top, 560 - bounds.bottom, 560),
  }
}

export function rotateHouseItem(item: Item): (Point & Pick<Item, 'rotation'>) | null {
  const rotation = (item.rotation + 450) % 360
  const before = itemBounds(item, item.rotation)
  const after = itemBounds(item, rotation)
  if (after.right - after.left > 820 + 1e-8 || after.bottom - after.top > 560 + 1e-8) return null
  const delta = {
    x: (before.left + before.right - after.left - after.right) / 2,
    y: (before.top + before.bottom - after.top - after.bottom) / 2,
  }
  return { ...moveHouseItem({ ...item, rotation }, delta), rotation }
}
