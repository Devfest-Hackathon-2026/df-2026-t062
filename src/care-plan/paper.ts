import type { FormDef } from '../../core/form.ts'
import { expandPrintLayout } from '../../core/print-layout.ts'
import type { NeedInput, SlotInput } from '../../db/care-plans.ts'

const days = ['月', '火', '水', '木', '金', '土', '日']
const period = (p: { periodText?: string | null, periodFrom?: string | null, periodTo?: string | null }) =>
  p.periodText?.trim() || (p.periodFrom || p.periodTo ? `${p.periodFrom ?? ''}〜${p.periodTo ?? ''}` : '')

/** 未保存の入力をPDFと同じ公式様式の座標に展開する。原紙・罫線は一切生成しない。 */
export function officialPlanPages(form: FormDef, current: Record<string, unknown>, needs: NeedInput[], slots: SlotInput[]) {
  const services = new Map(needs.flatMap((n) => n.shortGoals?.flatMap((g) => g.services ?? []) ?? []).map((s) => [s.id, s.content]))
  return expandPrintLayout(form, {
    ...current,
    'plan.needs': needs.map((n) => ({
      need: n.need, longGoal: n.longGoal.goal, longGoalPeriod: period(n.longGoal),
      shortGoals: (n.shortGoals ?? []).map((g) => ({
        goal: g.goal, period: period(g), services: (g.services ?? []).map((s) => ({
          content: s.content, insured: s.insured, kind: s.kind ?? '', provider: s.provider ?? '',
          frequency: s.frequency ?? '', period: period(s),
        })),
      })),
    })),
    'plan.weekly': slots.filter((s) => s.scheduleType === 'weekly' && s.weekday && s.start && s.end).map((s) => ({
      day: days[s.weekday! - 1], start: s.start!, end: s.end!, service: services.get(s.serviceId) ?? '',
    })),
    'plan.nonWeeklyServices': slots.filter((s) => s.scheduleType === 'other' && s.note).map((s) => `${services.get(s.serviceId) ?? ''}: ${s.note}`).join('\n'),
  }, { checkOverflow: false }) // 入力途中の長文も編集可能に保ち、PDF出力時のoverflow検証は従来通り。
}
