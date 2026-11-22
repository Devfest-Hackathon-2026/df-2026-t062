import { z } from 'zod'
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s)
export const CareRecordCreate = z.object({ kind: z.literal('care_plan_5'), requestId: z.uuid() }).strict()
export const CareRecordQuery = z.object({
  q: z.string().max(300).default(''), from: date.optional(), to: date.optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).refine(q => !q.from || !q.to || q.from <= q.to)
export type CareRecordKind = z.infer<typeof CareRecordCreate>['kind']
export interface CareRecordSummary {
  id: string; seq: number; date: string | null; time: string | null; category: string | null; preview: string;
  revision: number; updatedAt: string
}
export interface CareRecordRevision { rev: number; savedAt: string; formVersionId: string; values: Record<string, unknown> }
