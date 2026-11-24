import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PDFDocument } from '@pdfme/pdf-lib'
import { createCanvas } from '@napi-rs/canvas'
import { readDocument } from '../worker/document-input/read.ts'
import type { Ask, Prompt } from '../worker/vertex/gemini.ts'

const read = { entries: [{ text: '移動：一部介助', recordedOn: null, region: [0.1, 0.2, 0.6, 0.3], uncertain: false }], issues: [] }
const ask: Ask = async () => read
async function scannedPdf() {
  const pdf = await PDFDocument.create()
  const canvas = createCanvas(120, 80)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 120, 80)
  ctx.fillStyle = 'black'; ctx.fillText('Synthetic sample', 4, 30)
  const image = await pdf.embedPng(canvas.toBuffer('image/png'))
  pdf.addPage([300, 400]).drawImage(image, { x: 10, y: 20, width: 200, height: 150 })
  return pdf.save()
}
test('画像だけのスキャンPDFをPNG＋抽出文字で読み、書類のVisitと安定した根拠IDにする', async () => {
  let prompt: Prompt = ''
  const r = await readDocument(await scannedPdf(), { id: 'sample', mime: 'application/pdf', ask: async (p) => { prompt = p; return read } })
  assert.ok(Array.isArray(prompt) && prompt.some((p) => 'png' in p))
  assert.equal(r.visit.scenes[0].kind, '書類')
  assert.equal(r.visit.date, '不明')
  assert.equal(r.evidence[0].recordedOn, null)
  assert.equal(r.evidence[0].id, 'dsample-p1-1')
  assert.equal(r.visit.scenes[0].entries[0].id, r.evidence[0].id)
  assert.deepEqual(r.evidence[0].region, [0.1, 0.2, 0.6, 0.3])
})
test('文字付きPDFも同じ経路で画像と文字を渡す', async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage().drawText('Synthetic discharge report')
  await readDocument(await pdf.save(), { id: 'text', mime: 'application/pdf', ask: async (p) => {
    assert.ok(Array.isArray(p) && p.some((v) => 'text' in v && v.text.includes('Synthetic')))
    return read
  } })
})
test('大きなページは全体と重なりのある拡大図を一度の読取に渡す', async () => {
  const canvas = createCanvas(1600, 1200)
  let calls = 0
  await readDocument(canvas.toBuffer('image/png'), { id: 'zoom', mime: 'image/png', ask: async (prompt) => {
    calls++
    assert.ok(Array.isArray(prompt))
    assert.equal(prompt.filter((part) => 'png' in part).length, 5)
    return read
  } })
  assert.equal(calls, 1)
})
test('PNGとJPEGは同じ経路で読み、曖昧な文字と矛盾は原文に残す', async () => {
  const c = createCanvas(120, 120)
  for (const mime of ['image/png', 'image/jpeg'] as const) {
    const r = await readDocument(mime === 'image/png' ? c.toBuffer('image/png') : c.toBuffer('image/jpeg'), { id: 'image', mime, ask: async () => ({
      entries: [{ ...read.entries[0], recordedOn: '2026-11-01', uncertain: true }], issues: ['複数印のため選択を特定できません'],
    }) })
    assert.equal(r.evidence[0].uncertain, true)
    assert.equal(r.visit.scenes[0].entries[0].date, '2026-11-01')
    assert.match(r.visit.scenes[0].entries[0].text, /要確認/)
    assert.equal(r.issues[0].page, 1)
  }
})
test('完了したページは再試行時にGeminiへ送らず、根拠IDも変えない', async () => {
  const pdf = await scannedPdf()
  let saved: unknown
  const first = await readDocument(pdf, { id: 'resume', mime: 'application/pdf', ask, onPage: async (_p, value) => { saved = value } })
  const second = await readDocument(pdf, { id: 'resume', mime: 'application/pdf', ask: async () => { throw new Error('呼ばない') }, pages: { 1: saved as never } })
  assert.deepEqual(second, first)
})
test('不正ファイル・過大画像・ページ超過・壊れたモデル応答を拒否する', async () => {
  await assert.rejects(readDocument(new Uint8Array([1]), { id: 'x', mime: 'image/jpeg', ask }), /invalid_file/)
  const b = createCanvas(10, 10).toBuffer('image/png')
  b.writeUInt32BE(50000, 16)
  await assert.rejects(readDocument(b, { id: 'x', mime: 'image/png', ask }), /image_too_large/)
  const pdf = await PDFDocument.create()
  for (let i = 0; i < 31; i++) pdf.addPage()
  await assert.rejects(readDocument(await pdf.save(), { id: 'x', mime: 'application/pdf', ask }), /too_many_pages/)
  await assert.rejects(readDocument(await scannedPdf(), { id: 'x', mime: 'application/pdf', ask: async () => ({ entries: [{ text: '不正日付', recordedOn: '2026-02-30' }] }) }))
})

test('処理地域の明示確認がないと書類読取を有効にしない。既存の録音writerは使える', async () => {
  const { vertexProviders } = await import('../worker/vertex/index.ts')
  const providers = vertexProviders({ GOOGLE_CLOUD_PROJECT: 'synthetic-project', GEMINI_LOCATION: 'global' })
  assert.ok(providers.recording.writer)
  assert.throws(() => providers.documentRead!(), /location_not_approved/)
  const approved = vertexProviders({ GOOGLE_CLOUD_PROJECT: 'synthetic-project', GEMINI_LOCATION: 'global', DOCUMENT_INPUT_APPROVED_LOCATION: 'global' })
  assert.equal(typeof approved.documentRead!().ask, 'function')
})

test('補助領域の座標が逆転していても原文を失わず、領域は不明にする。JSON Schemaの配列はitemsで定義する', async () => {
  const canvas = createCanvas(10, 10)
  const result = await readDocument(canvas.toBuffer('image/png'), { id: 'invalid-region', mime: 'image/png', ask: async (_prompt, schema) => {
    const encoded = JSON.stringify(schema)
    assert.equal(encoded.includes('prefixItems'), false)
    assert.equal(encoded.includes('$schema'), false)
    assert.equal(encoded.includes('pattern'), false)
    assert.equal(encoded.includes('minLength'), false)
    return { entries: [{ text: '移動は見守り。', recordedOn: null, region: [0.7, 0.2, 0.3, 0.4], uncertain: false }], issues: [] }
  } })
  assert.equal(result.evidence[0].region, null)
  assert.equal(result.evidence[0].text, '移動は見守り。')
  assert.equal(result.evidence[0].uncertain, false)
})

test('領域がページ外・長さ違いなら不明にし、原文は保持する', async () => {
  const canvas = createCanvas(10, 10)
  for (const region of [[0.1, 0.1, 0.5, 1.2], [0.1, 0.2]]) {
    const result = await readDocument(canvas.toBuffer('image/png'), { id: 'unknown-region', mime: 'image/png', ask: async () => ({
      entries: [{ text: '食事は見守り。', recordedOn: null, region, uncertain: false }], issues: [],
    }) })
    assert.equal(result.evidence[0].region, null)
    assert.equal(result.evidence[0].text, '食事は見守り。')
  }
})
test('原文を読めない行でも、明示された確認対象を自由文の警告と分けて保持する', async () => {
  const result = await readDocument(createCanvas(10, 10).toBuffer('image/png'), { id: 'labels', mime: 'image/png', ask: async () => ({
    entries: [], issues: ['移動以外は未記入です'], reviewLabels: ['食事摂取'],
  }) })
  assert.deepEqual(result.issues.flatMap((issue) => issue.labels ?? []), ['食事摂取'])
  assert.ok(result.issues.some((issue) => issue.text === '移動以外は未記入です' && !issue.labels))
})
