import { diagramSchema } from '../core/diagram/fields.ts'
// 保存した版から、様式の PDF を作る（pdfme）。AI が書いただけで保存していない値は出ない。
// 元の PDF は、その版が指す PDF（非公開の置き場 forms の pdf/<sha256>/base.pdf。npm run forms:assets が入れる）。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { renderAll } from '../core/binding.ts'
import { basePdfPath, type FormVersion } from '../db/forms.ts'
import type { Storage } from './storage.ts'

/** 様式の元の PDF が、まだ置き場にない（npm run forms:assets） */
export class FormUnavailable extends Error {}

const FONT = new URL('../forms/fonts/BIZUDPGothic-Regular.ttf', import.meta.url)
let font: Promise<Uint8Array<ArrayBuffer>> | undefined
const bases = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()
const own = (b: Uint8Array) => new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)

async function loadBase(storage: Storage, v: FormVersion): Promise<Uint8Array<ArrayBuffer>> {
  const buf = await storage.read('forms', basePdfPath(v)).catch(() => null)
  if (!buf || createHash('sha256').update(buf).digest('hex') !== v.basePdfSha256) throw new FormUnavailable(v.id)
  return own(buf)
}

export async function makePdf(storage: Storage, v: FormVersion, values: Record<string, unknown>): Promise<Uint8Array<ArrayBuffer>> {
  const [{ generate }, { text, circleMark, image }] = await Promise.all([import('@pdfme/generator'), import('@pdfme/schemas')])
  font ??= readFile(FONT).then(own)
  if (!bases.has(v.id)) {
    const p = loadBase(storage, v)
    p.catch(() => bases.delete(v.id))
    bases.set(v.id, p)
  }
  const inputs = renderAll(v.bindings, values)
  const schemas = await Promise.all(v.schemas.map(async (page) => {
    const slots = await Promise.all(page.map(async (slot) => {
      const binding = v.bindings[slot.name]
      if (binding?.op !== 'diagram@1') return slot
      const parsed = diagramSchema.safeParse(values[binding.ref.key])
      if (!parsed.success) {
        if (values[binding.ref.key] != null) throw new Error('保存した図のデータが不正です')
        return null
      }
      const { diagramImage } = await import('./diagram-image.ts')
      inputs[slot.name] = await diagramImage(parsed.data, slot.width, slot.height)
      return slot
    }))
    return slots.filter((slot) => slot !== null)
  }))
  const template = { basePdf: await bases.get(v.id)!, schemas }
  const pdf = await generate({
    template: template as never,
    inputs: [inputs],
    plugins: { text, circleMark, image } as never,
    options: { font: { BIZUDPGothic: { data: await font, fallback: true, subset: true } } },
  })
  return pdf as Uint8Array<ArrayBuffer>
}
