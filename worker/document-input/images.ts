import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { Part } from '../vertex/gemini.ts'

/** 原本を残したまま、拡大と濃いインクだけの補助表示を作る。選択の判定や値の割当はしない。 */
export async function pageImages(png: Uint8Array): Promise<{ original: Part[], dark: Part[] }> {
  const image = await loadImage(Buffer.from(png))
  const original: Part[] = [{ text: '原本全体' }, { png }]
  const filtered: Part[] = []
  if (Math.max(image.width, image.height) < 1200) return { original, dark: filtered }
  const dark = createCanvas(image.width, image.height)
  const ctx = dark.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const pixels = ctx.getImageData(0, 0, dark.width, dark.height)
  for (let i = 0; i < pixels.data.length; i += 4) {
    const gray = .2126 * pixels.data[i] + .7152 * pixels.data[i + 1] + .0722 * pixels.data[i + 2]
    const value = gray < 160 ? 0 : 255
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value
  }
  ctx.putImageData(pixels, 0, 0)
  filtered.push({ text: '濃いインクのみの補助画像。原本の薄い画素を除去した表示で、原本の代わりではありません。' }, { png: dark.toBuffer('image/png') })
  for (const [source, title, parts] of [[image, '原本', original], [dark, '濃いインクのみの補助画像', filtered]] as const) {
    for (const y of [0, .45]) for (const x of [0, .45]) {
      const canvas = createCanvas(Math.ceil(image.width * .55), Math.ceil(image.height * .55))
      canvas.getContext('2d').drawImage(source, x * image.width, y * image.height, image.width * .55, image.height * .55, 0, 0, canvas.width, canvas.height)
      parts.push({ text: `${title}の拡大（全体での左上位置 ${x}, ${y}）。隣接部分は重複しています。` }, { png: canvas.toBuffer('image/png') })
    }
  }
  return { original, dark: filtered }
}
