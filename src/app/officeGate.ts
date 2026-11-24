// 書類の設定（/office の画面）を開けるかを決める。責任者（admin）だけ、PC で開ける（#111・#153）
import type { Route } from './routes.ts'

export type OfficeGate = { ok: true } | { ok: false, message: string }

const NOT_MANAGER = '書類の設定は、事業所の責任者だけが使えます。'
const USE_PC = '書類の設定は PC で開いてください。'

export function officeGate(route: Route, role: string, device: 'pc' | 'pad'): OfficeGate {
  if (!route.name.startsWith('office')) return { ok: true }
  if (role !== 'admin') return { ok: false, message: NOT_MANAGER }
  if (device !== 'pc') return { ok: false, message: USE_PC }
  return { ok: true }
}
