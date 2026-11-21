import { z } from 'zod'

/** 手入力とAI候補で、曜日・時刻・期間の入力形式を共用する。 */
export const PlanSlotSchema = z.object({
  id: z.string().uuid().optional(),
  serviceId: z.string().uuid(),
  scheduleType: z.enum(['weekly', 'other']),
  weekday: z.number().int().nullish(),
  start: z.string().max(20).nullish(),
  end: z.string().max(20).nullish(),
  endsNextDay: z.boolean().optional(),
  note: z.string().max(1000).nullish(),
  periodFrom: z.iso.date().nullish(),
  periodTo: z.iso.date().nullish(),
})
/** AIの位置参照は同じ原案内の配列添字。既存サービスのIDや名前で推測しない。 */
export const AiPlanSlotSchema = PlanSlotSchema.omit({ id: true, serviceId: true }).extend({
  serviceRef: z.object({ need: z.number().int().nonnegative(), shortGoal: z.number().int().nonnegative(), service: z.number().int().nonnegative() }),
}).strict()
