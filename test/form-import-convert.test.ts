// 様式の取り込み（#99）: 1 ページの変換（worker/form-import/convert.ts）。Gemini は偽物に差し替える。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { generate } from '@pdfme/generator'
import { text, rectangle } from '@pdfme/schemas'
import { openPdf } from '../worker/form-import/pdf.ts'
import { convertPage } from '../worker/form-import/convert.ts'
import type { AskMeta, Prompt } from '../worker/vertex/gemini.ts'

const font = { BIZUDPGothic: { data: readFileSync(new URL('../forms/fonts/BIZUDPGothic-Regular.ttf', import.meta.url)), fallback: true, subset: true } }

/** 氏名のマス（2 つ並んだ四角の右）と、「□有 □無」の □ がある用紙 */
async function samplePdf(): Promise<Uint8Array> {
  const t = (name: string, x: number, y: number) => ({
    name, type: 'text', position: { x, y }, width: 60, height: 8, fontName: 'BIZUDPGothic', fontSize: 12,
    alignment: 'left', verticalAlignment: 'top', lineHeight: 1, characterSpacing: 0, fontColor: '#000000', content: '',
  })
  const r = (name: string, x: number) => ({ name, type: 'rectangle', position: { x, y: 30 }, width: 40, height: 10, borderWidth: 0.3, borderColor: '#000000', color: '', readOnly: true, content: '' })
  const pdf = await generate({
    template: { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[r('見出し', 20), r('記入', 60), t('氏名', 22, 32), t('有無', 20, 60)]] } as never,
    inputs: [{ 氏名: '氏名', 有無: '□有 □無' }],
    plugins: { text, rectangle },
    options: { font },
  })
  return new Uint8Array(pdf)
}

const images = (p: Prompt) => (typeof p === 'string' ? 0 : p.filter((x) => 'png' in x).length)
const textOf = (p: Prompt) => (typeof p === 'string' ? p : p.map((x) => ('text' in x ? x.text : '')).join('\n'))

test('1 回目の答えを、マスと □ の番号で正確な位置に置き直し、見直しの直しと漏れを当て、変わらなくなったら止める', async () => {
  const pdf = await openPdf(await samplePdf())
  const calls: { meta: AskMeta, images: number, text: string }[] = []
  const ask = async (prompt: Prompt, _schema: unknown, meta: AskMeta) => {
    calls.push({ meta, images: images(prompt), text: textOf(prompt) })
    const t = textOf(prompt)
    if (calls.length === 1) {
      // マスと □ の番号は、指示文の一覧から拾う（記入のマスは x=60 付近から、□ は 2 つ）
      const cell = Number(t.match(/^(\d+): (?:59\.\d+|60(?:\.\d+)?),30/m)![1])
      return {
        slots: [
          { x: 0, y: 0, w: 1, h: 1, ui: 'text', ref: 'person.name', cell, label: '氏名', confidence: 0.9 },
          { x: 0, y: 0, w: 1, h: 1, ui: 'check', ref: 'pet', box: 1, label: '有', confidence: 0.9 },
          { x: 300, y: 10, w: 5, h: 5, ui: 'text', ref: 'person.name', label: 'ページの外', confidence: 0.1 },
        ],
        localFields: [{ key: 'pet', label: 'ペットの有無', type: 'bool' }],
      }
    }
    if (calls.length === 2) {
      assert.match(t, /使われていないもの[\s\S]*^2: /m, '使われていない □（2 番）を見直しで聞く')
      return { slots: [{ x: 0, y: 0, w: 1, h: 1, ui: 'check', ref: 'local.pet', box: 2, mark: { kind: 'false' }, label: '無', confidence: 0.8 }], fixes: [{ id: 2, slot: { x: 0, y: 0, w: 1, h: 1, ui: 'check', ref: 'local.pet', box: 1, label: '有', confidence: 0.9 } }], removes: [], localFields: [] }
    }
    return { slots: [], fixes: [], removes: [], localFields: [] }
  }
  try {
    const d = await convertPage(pdf, 1, { ask, catalog: ['person.name｜氏名｜text'] })
    assert.deepEqual(calls.map((c) => [c.meta.step, c.images]), [['様式の欄', 1], ['様式の見直し', 2], ['様式の見直し', 2]])
    assert.match(calls[0].text, /person\.name｜氏名｜text/, '1 回目に key の一覧を渡す')
    const name = d.slots.find((s) => s.ref === 'person.name')!
    assert.ok(name.x > 60 && name.x < 61.5 && name.w > 37 && name.w < 40, `マスの内側に置く: ${JSON.stringify(name)}`)
    const [yes, no] = ['有', '無'].map((l) => d.slots.find((s) => s.label === l)!)
    assert.ok(yes.x >= 19 && yes.x <= 21 && yes.w > 1.5 && yes.w < 6.5, `□ の位置に置く: ${JSON.stringify(yes)}`)
    assert.ok(no.x > yes.x + 3, '2 つめの □')
    assert.deepEqual(yes.mark, { kind: 'true' }, 'はい・いいえの key の □ で印がなければ「はい」')
    assert.deepEqual(no.mark, { kind: 'false' })
    assert.equal(d.slots.length, 3, 'ページの外の欄は捨てる')
    assert.equal(d.outside, 1)
    assert.deepEqual(d.localFields.map((f) => f.key), ['local.pet'], 'local. を付け忘れた定義は補う')
    assert.deepEqual(d.rounds.map((r) => [r.added, r.fixed, r.removed]), [[2, 0, 0], [1, 1, 0], [0, 0, 0]])
  } finally { await pdf.close() }
})

test('見直しは REVIEW_MAX 回で止める', async () => {
  const pdf = await openPdf(await samplePdf())
  let n = 0
  const ask = async () => {
    n++
    // 毎回 1 欄ずつ足し続ける（止まらない答え）
    return { slots: [{ x: 100, y: 100 + n * 10, w: 20, h: 5, ui: 'text', ref: 'person.name', label: `欄${n}`, confidence: 1 }], fixes: [], removes: [], localFields: [] }
  }
  try {
    const d = await convertPage(pdf, 1, { ask, catalog: [], reviewMax: 2 })
    assert.equal(n, 3, '1 回目＋見直し 2 回')
    assert.equal(d.slots.length, 3)
  } finally { await pdf.close() }
})
