// 様式の取り込み（#99）: PDF から文字・語・罫線の座標を取り出す（worker/form-import/pdf.ts）。
// 位置の分かっている文字と四角を @pdfme/generator で描いた PDF で確かめる（実物の様式は公開リポジトリに入れない）。
// 実物の様式での確かめ（Python の取り出しと比べる）は forms/tools/import/verify-layout.ts。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { generate } from '@pdfme/generator'
import { text, rectangle, line } from '@pdfme/schemas'
import { openPdf } from '../worker/form-import/pdf.ts'
import { PDFDocument, PDFName } from '@pdfme/pdf-lib'
import { loadImage, createCanvas } from '@napi-rs/canvas'

const font = { BIZUDPGothic: { data: readFileSync(new URL('../forms/fonts/BIZUDPGothic-Regular.ttf', import.meta.url)), fallback: true, subset: true } }
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

async function bitmapPdf(bitmap: Uint8Array, filter: string) {
  const pdf = await PDFDocument.create()
  const image = pdf.context.register(pdf.context.stream(bitmap, {
    Type: 'XObject', Subtype: 'Image', Width: 128, Height: 128, ColorSpace: 'DeviceGray', BitsPerComponent: 1,
    Filter: filter, DecodeParms: { K: -1, Columns: 128, Rows: 128, BlackIs1: true },
  }))
  const page = pdf.addPage([128, 128])
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Scan: image } }))
  const drawing = pdf.context.register(pdf.context.stream('q 128 0 0 128 0 0 cm /Scan Do Q'))
  page.node.set(PDFName.of('Contents'), drawing)
  return pdf.save()
}

test('CCITT圧縮のスキャン画像を消さずに描画する（復号用WASMをローカルから読む）', async () => {
  // 自作の128px白地＋中央64px黒正方形をGroup4圧縮したもの。自治体資料は含まない。
  const bitmap = Buffer.from('JqGQG///////////INWzX//////////////////////////////////////////H//////////gAgAg=', 'base64')
  const opened = await openPdf(await bitmapPdf(bitmap, 'CCITTFaxDecode'))
  try {
    const png = await loadImage(await opened.png(1, 72))
    const canvas = createCanvas(128, 128)
    canvas.getContext('2d').drawImage(png, 0, 0)
    const pixel = (x: number, y: number) => canvas.getContext('2d').getImageData(x, y, 1, 1).data[0]
    assert.ok(pixel(64, 64) < 30, '中央の黒い画像が欠けていない')
    assert.ok(pixel(8, 8) > 240, '白地は白のまま')
  } finally { await opened.close() }
})

test('画像だけの復号に失敗したPDFを、白紙の原本として正常終了しない', async () => {
  const opened = await openPdf(await bitmapPdf(new Uint8Array([0, 1, 2]), 'JPXDecode'))
  try { await assert.rejects(opened.png(1, 72), /pdf_image_decode_failed/) }
  finally { await opened.close() }
})

async function samplePdf(): Promise<Uint8Array> {
  const t = (name: string, x: number, y: number, size: number) => ({
    name, type: 'text', position: { x, y }, width: 80, height: 8, fontName: 'BIZUDPGothic', fontSize: size,
    alignment: 'left', verticalAlignment: 'top', lineHeight: 1, characterSpacing: 0, fontColor: '#000000', content: '',
  })
  const template = {
    basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] as [number, number, number, number] },
    schemas: [[
      { name: '枠', type: 'rectangle', position: { x: 20, y: 30 }, width: 50, height: 10, borderWidth: 0.3, borderColor: '#000000', color: '', readOnly: true, content: '' },
      { name: '線', type: 'line', position: { x: 20, y: 60 }, width: 100, height: 0.3, color: '#000000', readOnly: true, content: '' },
      t('文1', 100, 50, 12),
      t('文2', 100, 70, 10),
    ]],
  }
  const pdf = await generate({ template: template as never, inputs: [{ 文1: '□有', 文2: 'AB CD' }], plugins: { text, rectangle, line }, options: { font } })
  return new Uint8Array(pdf)
}

test('ページの大きさは mm、左上が原点', async () => {
  const pdf = await openPdf(await samplePdf())
  try {
    assert.equal(pdf.numPages, 1)
    const p = await pdf.layout(1)
    assert.ok(near(p.width, 210, 0.05) && near(p.height, 297, 0.05), `${p.width}x${p.height}`)
  } finally { await pdf.close() }
})

test('四角と線: 四角の 4 辺と、横線を、位置（mm）つきで取り出す', async () => {
  const pdf = await openPdf(await samplePdf())
  try {
    const p = await pdf.layout(1)
    const h = (y: number, x0: number, x1: number) => p.hlines.some(([ly, a, b]) => near(ly, y, 0.3) && near(a, x0, 0.3) && near(b, x1, 0.3))
    const v = (x: number, y0: number, y1: number) => p.vlines.some(([lx, a, b]) => near(lx, x, 0.3) && near(a, y0, 0.3) && near(b, y1, 0.3))
    assert.ok(h(30, 20, 70) && h(40, 20, 70), `四角の上下: ${JSON.stringify(p.hlines)}`)
    assert.ok(v(20, 30, 40) && v(70, 30, 40), `四角の左右: ${JSON.stringify(p.vlines)}`)
    assert.ok(p.hlines.some(([ly, a, b]) => near(ly, 60, 0.5) && near(a, 20, 0.3) && near(b, 120, 0.3)), '横線')
  } finally { await pdf.close() }
})

test('文字: 1 文字ずつの枠と、空白で分けた語。□ はインクの範囲も測る', async () => {
  const pdf = await openPdf(await samplePdf())
  try {
    const p = await pdf.layout(1, { ink: true })
    const box = p.chars.find((c) => c.t === '□')!
    const yu = p.chars.find((c) => c.t === '有')!
    assert.ok(box && yu, JSON.stringify(p.chars))
    assert.ok(near(box.x0, 100, 0.3), `□ の左 ${box.x0}`)
    assert.ok(near(yu.x0, box.x1, 0.05), '「有」は □ のすぐ右')
    // 12pt の文字の高さは 12pt（4.23mm）
    assert.ok(near(box.y1 - box.y0, 12 * 25.4 / 72, 0.05), `高さ ${box.y1 - box.y0}`)
    assert.ok(box.y0 >= 49.5 && box.y1 <= 55.5, `□ の上下 ${box.y0}-${box.y1}`)
    assert.ok(box.ink && box.ink[0] >= box.x0 - 0.1 && box.ink[2] <= box.x1 + 0.1, `□ のインク ${box.ink}`)
    assert.deepEqual(p.words.filter((w) => w.y0 > 65).map((w) => w.t), ['AB', 'CD'])
    assert.equal(p.words.find((w) => w.t === '□有')?.t, '□有')
  } finally { await pdf.close() }
})

test('曲線の命令で描いた直線（端点と制御点が同じ線の上にある）も、罫線として拾う', async () => {
  // pdfme の line は直線の命令なので、曲線の命令の PDF を手で作る（A4、1pt = 1/72 インチ）
  // 3 本目は 400pt の長さで 0.05pt だけ傾いた縦線（紙の上では見えない傾き。縦線として拾う）
  const content = '0.5 w 100 700 m 133 700 166 700 200 700 c S 300 700 m 300 650 300 620 300 600 c S 400 700 m 450 760 500 640 550 700 c S 50 750 m 50.05 350 l S'
  const pdfText = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    'trailer << /Root 1 0 R >>',
    '%%EOF',
  ].join('\n')
  const pdf = await openPdf(new TextEncoder().encode(pdfText))
  try {
    const p = await pdf.layout(1)
    const mm = (v: number) => v * 25.4 / 72
    assert.ok(p.hlines.some(([y, a, b]) => near(y, mm(841.89 - 700), 0.05) && near(a, mm(100), 0.05) && near(b, mm(200), 0.05)), `横: ${JSON.stringify(p.hlines)}`)
    assert.ok(p.vlines.some(([x, a, b]) => near(x, mm(300), 0.05) && near(a, mm(841.89 - 700), 0.05) && near(b, mm(841.89 - 600), 0.05)), `縦: ${JSON.stringify(p.vlines)}`)
    assert.equal(p.hlines.filter(([y]) => near(y, mm(841.89 - 700), 0.05)).length, 1, '曲がった曲線は拾わない')
    assert.ok(p.vlines.some(([x, a, b]) => near(x, mm(50), 0.05) && near(a, mm(841.89 - 750), 0.05) && near(b, mm(841.89 - 350), 0.05)), `少し傾いた縦線: ${JSON.stringify(p.vlines)}`)
  } finally { await pdf.close() }
})

test('ページの画像（PNG）を指定の細かさで作る', async () => {
  const pdf = await openPdf(await samplePdf())
  try {
    const png = await pdf.png(1, 72)
    assert.deepEqual([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG')
    // 72dpi なら 1pt = 1px。A4 は 595×842
    const w = png.readUInt32BE(16)
    const h = png.readUInt32BE(20)
    assert.ok(near(w, 595, 1) && near(h, 842, 1), `${w}x${h}`)
  } finally { await pdf.close() }
})

// 点線を、短い画像を並べて描く PDF がある（厚生労働省のケアプラン第 3 表など。2mm×0.25mm の画像を 2mm おきに並べる）。#147
async function imageDashPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  // 5×1 画素の白黒の画像（黒 4 画素＋白 1 画素。点線の 1 区切り）
  const dash = pdf.context.register(pdf.context.stream(new Uint8Array([0b00001000]), {
    Type: 'XObject', Subtype: 'Image', Width: 5, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 1,
  }))
  const page = pdf.addPage([283.46, 283.46]) // 100mm 四方
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { D: dash } }))
  const mm = (v: number) => v * 72 / 25.4
  const ops: string[] = []
  const place = (x: number, yTop: number, w: number, h: number) => ops.push(`q ${mm(w)} 0 0 ${mm(h)} ${mm(x)} ${mm(100 - yTop - h)} cm /D Do Q`)
  // 横の点線: y=30（上端）から 0.25mm の厚さで、x=10〜50 を 2mm の画像 20 個で
  for (let k = 0; k < 20; k++) place(10 + 2 * k, 30, 2, 0.25)
  // 縦の点線: x=70 で、y=10〜30 を 2mm の画像 10 個で（画像を回さずに縦長に置く）
  for (let k = 0; k < 10; k++) place(70, 10 + 2 * k, 0.25, 2)
  // 写真のような大きい画像と、□ くらいの小さい正方形の画像は線にしない
  place(10, 60, 30, 20)
  place(60, 60, 0.25, 0.25)
  page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream(ops.join('\n'))))
  return pdf.save()
}

test('細い画像を並べて描いた点線も、罫線として拾う。大きい画像と小さい点は線にしない（#147）', async () => {
  const pdf = await openPdf(await imageDashPdf())
  try {
    const p = await pdf.layout(1)
    const atH = p.hlines.filter(([y]) => near(y, 30.13, 0.2))
    assert.equal(atH.length, 20, JSON.stringify(p.hlines))
    assert.ok(near(Math.min(...atH.map(([, a]) => a)), 10, 0.05) && near(Math.max(...atH.map(([, , b]) => b)), 50, 0.05))
    const atV = p.vlines.filter(([x]) => near(x, 70.13, 0.2))
    assert.equal(atV.length, 10, JSON.stringify(p.vlines))
    assert.ok(near(Math.min(...atV.map(([, a]) => a)), 10, 0.05) && near(Math.max(...atV.map(([, , b]) => b)), 30, 0.05))
    assert.ok(!p.hlines.some(([y]) => y > 55), `大きい画像・点の辺を線にしない: ${JSON.stringify(p.hlines.filter(([y]) => y > 55))}`)
    assert.ok(!p.vlines.some(([x, y0]) => y0 > 55), `大きい画像・点の辺を線にしない: ${JSON.stringify(p.vlines.filter(([, y0]) => y0 > 55))}`)
  } finally { await pdf.close() }
})
