import { z } from 'zod'
import { blank, schema, type Doc, type Tab } from './model.ts'

export const diagramKinds: Record<string, Tab> = {
  'family.genogram': 'family',
  'housing.floorPlan': 'house',
  'health.bodyMap': 'body',
}

export const diagramSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('house'), revision: z.number().int().nonnegative(), data: schema.shape.house }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('family'), revision: z.number().int().nonnegative(), data: schema.shape.family }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('body'), revision: z.number().int().nonnegative(), data: schema.shape.body }).strict(),
]).superRefine((value, ctx) => {
  const result = schema.safeParse({ ...blank(), [value.kind]: value.data })
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', message: issue.message })
  if (value.kind === 'house' && value.data.items.some((item) => !['room', 'wall', 'bed', 'rail', 'step', 'wheelchair', 'furniture', 'note'].includes(item.kind))) {
    ctx.addIssue({ code: 'custom', message: '家屋に使えない図形があります' })
  }
  if (value.kind === 'body' && value.data.items.some((item) => !['disability', 'loss', 'pressure', 'pain', 'paralysis', 'contracture', 'note'].includes(item.kind))) {
    ctx.addIssue({ code: 'custom', message: '身体図に使えない記号があります' })
  }
})
export type DiagramValue = z.infer<typeof diagramSchema>
export interface DiagramField { id: string, title: string, kind: Tab, value: DiagramValue | null }

export function diagramDocument(value: DiagramValue | null): Doc {
  return value ? schema.parse({ ...blank(), [value.kind]: value.data }) : blank()
}

export function nextDiagram(kind: Tab, doc: Doc, revision: number): DiagramValue {
  return diagramSchema.parse({ version: 1, kind, revision: revision + 1, data: doc[kind] })
}

export function validDiagramUpdate(key: string, value: unknown, base: unknown): boolean {
  if (!diagramKinds[key]) return true
  if (value === null) return false
  const parsed = diagramSchema.safeParse(value)
  const previous = diagramSchema.safeParse(base)
  if (base != null && (!previous.success || previous.data.kind !== diagramKinds[key])) return false
  return parsed.success && parsed.data.kind === diagramKinds[key] &&
    parsed.data.revision === (previous.success ? previous.data.revision : 0) + 1
}
