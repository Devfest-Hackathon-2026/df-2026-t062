// 様式の取り込み（#99）: PDF 全体の変換の入口（worker/form-import/index.ts）。同じ用紙の見分け・失敗の扱い・出口の確かめ。
// Gemini は偽物に差し替える。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { generate } from '@pdfme/generator'
import { text, rectangle } from '@pdfme/schemas'
import { checkDraftVersion, errorKindOfOpen, importPdf } from '../worker/form-import/index.ts'
import type { Ask } from '../worker/vertex/gemini.ts'

const font = { BIZUDPGothic: { data: readFileSync(new URL('../forms/fonts/BIZUDPGothic-Regular.ttf', import.meta.url)), fallback: true, subset: true } }
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

async function formPdf(pages = 1, withText = true): Promise<Uint8Array> {
  const schemas = Array.from({ length: pages }, (_, i) => [
    { name: `枠${i}`, type: 'rectangle', position: { x: 60, y: 30 }, width: 40, height: 10, borderWidth: 0.3, borderColor: '#000000', color: '', readOnly: true, content: '' },
    ...(withText ? [{ name: `名${i}`, type: 'text', position: { x: 20, y: 32 }, width: 30, height: 8, fontName: 'BIZUDPGothic', fontSize: 12, alignment: 'left', verticalAlignment: 'top', lineHeight: 1, characterSpacing: 0, fontColor: '#000000', content: '' }] : []),
  ])
  const inputs = Object.fromEntries(Array.from({ length: pages }, (_, i) => [`名${i}`, '氏名']))
  const pdf = await generate({ template: { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas } as never, inputs: [withText ? inputs : {}], plugins: { text, rectangle }, options: { font } })
  return new Uint8Array(pdf)
}

/** 1 回目は氏名の欄、見直しは「直すところなし」と答える偽の Gemini */
const okAsk: Ask = async (_p, _s, meta) => (meta.step === '様式の欄'
  ? { slots: [{ x: 61, y: 31, w: 38, h: 8, ui: 'text', ref: 'person.name', label: '氏名', confidence: 1 }], localFields: [] }
  : { slots: [], fixes: [], removes: [], localFields: [] })

test('変換できたら、版の 4 つと要確認の一覧と元の PDF のハッシュを返す。出口の確かめも通る', async () => {
  const pdf = await formPdf(2)
  const r = await importPdf(pdf, { ask: okAsk })
  assert.equal(r.status, 'succeeded')
  if (r.status !== 'succeeded') return
  assert.equal(r.basePdfSha256, sha(pdf))
  assert.deepEqual(Object.keys(r.draft.bindings), ['p1_氏名', 'p2_氏名'])
  assert.deepEqual(r.draft.pages.map((p) => [p.no, p.pdfIndex]), [[1, 0], [2, 1]])
  assert.equal(r.draft.schemas.length, 2)
  assert.deepEqual(r.draft.review, [])
  assert.deepEqual(checkDraftVersion(r.draft), [])
})

test('登録済みの全体の様式と同じ PDF（ハッシュが同じ）なら、変換せずに matched', async () => {
  const pdf = await formPdf()
  let called = 0
  const r = await importPdf(pdf, { ask: async () => { called++; return {} }, knownSha256: new Set([sha(pdf)]) })
  assert.deepEqual(r, { status: 'matched', basePdfSha256: sha(pdf) })
  assert.equal(called, 0)
})

test('失敗: PDF でない・大きすぎる・ページが多すぎる・文字がない（スキャンした紙）', async () => {
  const notPdf = new TextEncoder().encode('これは PDF ではない')
  assert.deepEqual(await importPdf(notPdf, { ask: okAsk }), { status: 'failed', basePdfSha256: sha(notPdf), errorKind: 'invalid_pdf' })
  const pdf = await formPdf(3)
  assert.equal((await importPdf(pdf, { ask: okAsk, limits: { maxBytes: 100 } })).status, 'failed')
  assert.deepEqual(await importPdf(pdf, { ask: okAsk, limits: { maxBytes: 100 } }), { status: 'failed', basePdfSha256: sha(pdf), errorKind: 'too_large' })
  assert.deepEqual(await importPdf(pdf, { ask: okAsk, limits: { maxPages: 2 } }), { status: 'failed', basePdfSha256: sha(pdf), errorKind: 'too_many_pages' })
  const scan = await formPdf(1, false)
  assert.deepEqual(await importPdf(scan, { ask: okAsk }), { status: 'failed', basePdfSha256: sha(scan), errorKind: 'no_text' })
})

test('失敗: 添付ファイルやスクリプトが入った PDF は受けない', async () => {
  const content = 'BT /F1 12 Tf 100 700 Td (Form) Tj ET'
  const parts = (extra: string) => [
    '%PDF-1.4',
    `1 0 obj << /Type /Catalog /Pages 2 0 R ${extra} >> endobj`,
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >> endobj',
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    '5 0 obj << /Type /Filespec /F (a.txt) /EF << /F 6 0 R >> >> endobj',
    '6 0 obj << /Type /EmbeddedFile /Length 3 >> stream\nabc\nendstream endobj',
    '7 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    'trailer << /Root 1 0 R >>', '%%EOF',
  ].join('\n')
  const attached = new TextEncoder().encode(parts('/Names << /EmbeddedFiles << /Names [(a.txt) 5 0 R] >> >>'))
  assert.deepEqual(await importPdf(attached, { ask: okAsk }), { status: 'failed', basePdfSha256: sha(attached), errorKind: 'unsafe_pdf' })
  const script = new TextEncoder().encode(parts('/OpenAction << /S /JavaScript /JS (app.alert(1)) >>'))
  assert.deepEqual(await importPdf(script, { ask: okAsk }), { status: 'failed', basePdfSha256: sha(script), errorKind: 'unsafe_pdf' })
  const plain = new TextEncoder().encode(parts(''))
  assert.equal((await importPdf(plain, { ask: okAsk })).status, 'succeeded', '添付もスクリプトもない同じ PDF は通る')
})

test('失敗: パスワードで守られた PDF は encrypted、それ以外の開けない PDF は invalid_pdf', () => {
  assert.equal(errorKindOfOpen(Object.assign(new Error('No password given'), { name: 'PasswordException' })), 'encrypted')
  assert.equal(errorKindOfOpen(new Error('Invalid PDF structure.')), 'invalid_pdf')
})

test('失敗: 時間切れと AI の失敗（文面は返さない）', async () => {
  const pdf = await formPdf()
  const never: Ask = () => new Promise(() => {})
  assert.deepEqual(await importPdf(pdf, { ask: never, limits: { deadlineMs: 50 } }), { status: 'failed', basePdfSha256: sha(pdf), errorKind: 'timeout' })
  const broken: Ask = async () => { throw new Error('中身を含むかもしれない文面') }
  assert.deepEqual(await importPdf(pdf, { ask: broken }), { status: 'failed', basePdfSha256: sha(pdf), errorKind: 'ai_failed' })
})

test('出口の確かめ: すべての印字欄に対応がある・key が fields.json か local_fields にある・local_fields の key は local. で始まり重ならない', () => {
  const v = {
    schemas: [[{ name: 'a', type: 'text' as const, content: '', position: { x: 0, y: 0 }, width: 1, height: 1 }, { name: 'b', type: 'text' as const, content: '', position: { x: 0, y: 0 }, width: 1, height: 1 }]],
    bindings: { a: { op: 'text@1' as const, ui: 'text' as const, ref: { key: 'local.x' } }, c: { op: 'text@1' as const, ui: 'text' as const, ref: { key: 'local.y' } } },
    pages: [], review: [],
    localFields: [{ key: 'local.x', label: 'x', type: 'text' as const }, { key: 'local.x', label: 'x2', type: 'text' as const }, { key: 'z', label: 'z', type: 'text' as const }],
  }
  assert.deepEqual(checkDraftVersion(v), [
    '1 ページ: ページの寸法がありません',
    'b: 印字欄に対応がない',
    'c: 対応があるのに印字欄がない',
    'c: fields.json にも local_fields にもない key local.y',
    'local_fields: local.x が重なっている',
    'local_fields: z が local. で始まらない',
  ])
})

test('出口の形: 結果は zod の形に合う。見本（test/fixtures/form-import/result.json）も同じ形', async () => {
  const { ImportResultSchema } = await import('../worker/form-import/contract.ts')
  const r = await importPdf(await formPdf(2), { ask: okAsk })
  assert.equal(ImportResultSchema.safeParse(r).success, true)
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/form-import/result.json', import.meta.url), 'utf8'))
  const parsed = ImportResultSchema.safeParse(fixture)
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
  assert.equal(fixture.status, 'succeeded')
  for (const kind of ['invalid_pdf', 'encrypted', 'unsafe_pdf', 'too_large', 'too_many_pages', 'no_text', 'timeout', 'ai_failed']) {
    assert.equal(ImportResultSchema.safeParse({ status: 'failed', basePdfSha256: 'a'.repeat(64), errorKind: kind }).success, true, kind)
  }
  assert.equal(ImportResultSchema.safeParse({ status: 'failed', basePdfSha256: 'a'.repeat(64), errorKind: 'other' }).success, false)
})
