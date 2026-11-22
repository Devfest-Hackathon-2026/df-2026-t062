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

export interface CareRecordProposal { key: 'progress.content' | 'progress.category'; label: string; before: unknown; after: string }
export interface CareRecordSources { capturedAt: string; instructions: string; documents: { id: string, documentId: string, kind: string, rev: number, savedAt: string, formVersionId: string, values: Record<string, unknown> }[]; recordings: { id: string, recordedAt: string, utterances: unknown[] }[] }
export type CareRecordDrafter = (input: { source: CareRecordSources, current: Record<string, unknown>, form: import('./form.ts').FormDef }) => Promise<{ guidance: string, proposals: CareRecordProposal[] }>
export interface CareRecordDraftView {
  id: string; status: 'generating' | 'ready' | 'failed'; guidance: string; proposals: CareRecordProposal[]; errorCode: string | null;
  capturedAt: string; documentSources: { id: string, documentId: string, rev: number, savedAt: string }[]; recordingSources: { id: string, recordedAt: string }[]; appliedAt: string | null
}
export const CareRecordDraftCreate = z.object({ requestId: z.uuid(), instructions: z.string().trim().max(4000).default('') }).strict()
