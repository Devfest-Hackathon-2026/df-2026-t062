import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas'
import { diagramDocument, type DiagramValue } from '../core/diagram/fields.ts'
import { diagramSvg } from '../core/diagram/svg.ts'
let registered = false
let body: Promise<string> | undefined
/** Rasterize the same SVG as the editor, embedding both font and body artwork for offline PDF. */
export async function diagramImage(value: DiagramValue, width: number, height: number): Promise<string> {
  if (!registered) {
    if (!GlobalFonts.registerFromPath(fileURLToPath(new URL('../forms/fonts/BIZUDPGothic-Regular.ttf', import.meta.url)), 'BIZUDPGothic')) throw new Error('図のフォントを読み込めません')
    registered = true
  }
  body ??= readFile(new URL('../core/diagram/body.png', import.meta.url)).then((b) => `data:image/png;base64,${b.toString('base64')}`)
  const svg = diagramSvg(diagramDocument(value), value.kind, { cropBody: true, bodyImage: await body })
  // 家族図の小さい用紙欄でも氏名と関係線を読める約300dpi。ほかの図の解像度は維持する。
  const pixelsPerMm = value.kind === 'family' ? 12 : 4
  const canvas = createCanvas(Math.ceil(width * pixelsPerMm), Math.ceil(height * pixelsPerMm))
  const image = await loadImage(Buffer.from(svg.replace('<svg ', `<svg width="${canvas.width}" height="${canvas.height}" `)))
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}
