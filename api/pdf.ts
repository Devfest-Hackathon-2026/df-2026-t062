// 保存した版から、様式の PDF を作る（pdfme）。AI が書いただけで保存していない値は出ない。
// 元の PDF は、その版が指す PDF（非公開の置き場 forms の pdf/<sha256>/base.pdf。npm run forms:assets が入れる）。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basePdfPath, type FormVersion } from '../db/forms.ts'
import type { Storage } from './storage.ts'
import { expandPrintLayout } from './pdf-layout.ts'

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
  const [{ generate }, { text, circleMark }] = await Promise.all([import('@pdfme/generator'), import('@pdfme/schemas')])
  font ??= readFile(FONT).then(own)
  if (!bases.has(v.id)) {
    const p = loadBase(storage, v)
    p.catch(() => bases.delete(v.id))
    bases.set(v.id, p)
  }
  const pages = expandPrintLayout(v, values)
  let basePdf = await bases.get(v.id)!
  if (v.pages.some((p) => p.print)) {
    const { PDFDocument } = await import('@pdfme/pdf-lib')
    const source = await PDFDocument.load(basePdf)
    const expanded = await PDFDocument.create({ updateMetadata: false })
    for (const p of await expanded.copyPages(source, pages.map((p) => p.sourceIndex))) expanded.addPage(p)
    basePdf = own(await expanded.save())
  }
  // 各ページの入力名を独立させ、継続ページが前ページの値で置き換わらないようにする。
  const input: Record<string, string> = {}
  const schemas = pages.map((page, pageIndex) => page.schemas.map((slot) => {
    const name = `page${pageIndex}__${slot.name}`
    input[name] = page.input[slot.name] ?? ''
    return { ...slot, name }
  }))
  const template = { basePdf, schemas }
  const pdf = await generate({
    template: template as never,
    inputs: [input],
    plugins: { text, circleMark } as never,
    options: { font: { BIZUDPGothic: { data: await font, fallback: true, subset: true } } },
  })
  return pdf as Uint8Array<ArrayBuffer>
}
