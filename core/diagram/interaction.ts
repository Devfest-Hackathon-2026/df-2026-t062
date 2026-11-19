import type { Item, Person } from './model.ts'
/** The browser supplies the SVG screen matrix, including zoom and letterboxing. */
export function drawingPoint(point: { x: number, y: number }, matrix: { a: number, b: number, c: number, d: number, e: number, f: number }): { x: number, y: number } | null {
  const { a, b, c, d, e, f } = matrix
  const det = a * d - b * c
  if (!Number.isFinite(det) || det === 0) return null
  const x = (d * (point.x - e) - c * (point.y - f)) / det
  const y = (-b * (point.x - e) + a * (point.y - f)) / det
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 820 && y >= 0 && y <= 560 ? { x, y } : null
}
export function contains(object: Item | Person, point: { x: number, y: number }): boolean {
  const r = ('rotation' in object ? object.rotation : 0) * Math.PI / 180
  const dx = point.x - object.x, dy = point.y - object.y
  const x = dx * Math.cos(r) + dy * Math.sin(r), y = -dx * Math.sin(r) + dy * Math.cos(r)
  return x >= 0 && y >= 0 && x <= ('width' in object ? object.width : 120) && y <= ('height' in object ? object.height : 110)
}
