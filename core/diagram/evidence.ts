import { z } from 'zod'
export const sourceSchema = z.object({
  id: z.string().min(1).max(400),
  type: z.enum(['record', 'field', 'message']),
  label: z.string().min(1).max(300),
  quote: z.string().max(5000),
  recordedAt: z.string().max(50).optional(),
  documentId: z.string().max(100).optional(),
  field: z.string().max(200).optional(),
  confirmed: z.boolean().optional(),
}).strict()
export type DiagramSource = z.infer<typeof sourceSchema>
export const pendingLocationSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(['disability', 'loss', 'pressure', 'pain', 'paralysis', 'contracture', 'note']),
  label: z.string().min(1).max(300),
  view: z.enum(['front', 'back']).optional(),
  sources: z.array(sourceSchema).max(20).optional(),
}).strict()
export type PendingLocation = z.infer<typeof pendingLocationSchema>
