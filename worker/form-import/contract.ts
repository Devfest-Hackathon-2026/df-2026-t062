// 様式の取り込み（#99）の出口の形（#103 のワーカー・API が使う）。zod で確かめる。
//   ImportResultSchema … importPdf の結果（matched・succeeded・failed）
//   DraftVersionSchema … 下書きの版（form_template_versions の schemas・bindings・pages・local_fields）と要確認（form_imports.review）
// 形の確かめだけ。中身の確かめ（すべての印字欄に対応がある・key がある 等）は index.ts の checkDraftVersion。
// 見本: test/fixtures/form-import/result.json（架空の用紙から作ったもの）
import { z } from 'zod'

export const ImportErrorKindSchema = z.enum(['invalid_pdf', 'encrypted', 'unsafe_pdf', 'too_large', 'too_many_pages', 'no_text', 'timeout', 'ai_failed'])

export const ReviewItemSchema = z.object({ slot: z.string(), reason: z.string().min(1) })

export const LocalFieldSchema = z.object({
  key: z.string().regex(/^local\.[A-Za-z][A-Za-z0-9_]*$/),
  label: z.string().min(1),
  type: z.enum(['text', 'longtext', 'date', 'number', 'enum', 'bool']),
  choices: z.array(z.string()).optional(),
  note: z.string().optional(),
})

const Mm = z.number().finite()
export const PdfmeSlotSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['text', 'circleMark']),
  content: z.string(),
  position: z.object({ x: Mm, y: Mm }),
  width: Mm.positive(),
  height: Mm.positive(),
}).passthrough()

/** 対応の形（op ごとの中身は core/binding.ts の checkBindings で確かめる） */
export const BindingSchema = z.object({
  op: z.enum(['text@1', 'option@1', 'symbol@1', 'date@1', 'era@1', 'rhythm@1', 'ageAt@1', 'join@1']),
  ui: z.enum(['text', 'area', 'check', 'circle', 'cell']),
  ref: z.object({ key: z.string().min(1), path: z.array(z.unknown()).optional() }),
}).passthrough()

export const FormPageSchema = z.object({ no: z.number().int().positive(), pdfIndex: z.number().int().nonnegative(), title: z.string(), width: Mm.positive(), height: Mm.positive() })

export const DraftVersionSchema = z.object({
  schemas: z.array(z.array(PdfmeSlotSchema)),
  bindings: z.record(z.string(), BindingSchema),
  pages: z.array(FormPageSchema),
  localFields: z.array(LocalFieldSchema),
  review: z.array(ReviewItemSchema),
})

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)
export const ImportResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('matched'), basePdfSha256: Sha256 }),
  z.object({
    status: z.literal('succeeded'), basePdfSha256: Sha256, draft: DraftVersionSchema,
    stats: z.array(z.object({ page: z.number(), rounds: z.number(), outside: z.number(), cells: z.number(), boxes: z.number() })),
  }),
  z.object({ status: z.literal('failed'), basePdfSha256: Sha256, errorKind: ImportErrorKindSchema }),
])
