// 様式の取り込み（#99）: 見直し用の画像。ページに、ここまでの欄を赤い枠と番号で重ねる。
// 番号は欄の一覧の 1 からの順番。key の名前は枠に書かない（細かくて読めないので、番号ごとの中身は文字で渡す）。
import { fileURLToPath } from 'node:url'
import { GlobalFonts } from '@napi-rs/canvas'
import type { DraftSlot } from './draft.ts'
import type { OpenedPdf } from './pdf.ts'

/** 見直しの画像の細かさ。番号が読める細かさ（試しで決めた） */
export const REVIEW_DPI = 200

// 番号を描くフォント。コンテナに字体がないので、様式の印字に使っているフォントを登録する
const FONT = 'BIZUDPGothic'
let registered = false
function ensureFont() {
  if (registered) return
  GlobalFonts.registerFromPath(fileURLToPath(new URL('../../forms/fonts/BIZUDPGothic-Regular.ttf', import.meta.url)), FONT)
  registered = true
}

export async function overlayPng(pdf: OpenedPdf, page: number, slots: Pick<DraftSlot, 'x' | 'y' | 'w' | 'h'>[], dpi = REVIEW_DPI): Promise<Buffer> {
  ensureFont()
  return pdf.draw(page, dpi, (ctx, px) => {
    ctx.lineWidth = Math.max(1, px(0.2))
    ctx.strokeStyle = '#e00000'
    ctx.font = `${Math.round(px(2.2))}px ${FONT}`
    ctx.textBaseline = 'top'
    slots.forEach((s, i) => {
      ctx.strokeRect(px(s.x), px(s.y), Math.max(1, px(s.w)), Math.max(1, px(s.h)))
      const label = String(i + 1)
      const w = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.fillRect(px(s.x), px(s.y), w + px(0.4), px(2.4))
      ctx.fillStyle = '#e00000'
      ctx.fillText(label, px(s.x) + px(0.2), px(s.y) + px(0.1))
    })
  })
}
