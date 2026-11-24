// 様式の取り込み（#99）の出口の見本（test/fixtures/form-import/result.json）を作る。#103 の作りの見本にする。
// 架空の用紙（氏名のマス・「□有 □無」・家族の欄・行のある表）を描き、決まった答えを返す偽の Gemini で変換する。実在の情報は入らない。
//   node forms/tools/import/make-fixture.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { generate } from '@pdfme/generator'
import { text, rectangle } from '@pdfme/schemas'
import { importPdf } from '../../../worker/form-import/index.ts'
import type { Ask } from '../../../worker/vertex/gemini.ts'

const font = { BIZUDPGothic: { data: readFileSync(new URL('../../fonts/BIZUDPGothic-Regular.ttf', import.meta.url)), fallback: true, subset: true } }
const t = (name: string, x: number, y: number) => ({ name, type: 'text', position: { x, y }, width: 80, height: 8, fontName: 'BIZUDPGothic', fontSize: 12, alignment: 'left', verticalAlignment: 'top', lineHeight: 1, characterSpacing: 0, fontColor: '#000000', content: '' })
const r = (name: string, x: number, y: number, w: number) => ({ name, type: 'rectangle', position: { x, y }, width: w, height: 10, borderWidth: 0.3, borderColor: '#000000', color: '', readOnly: true, content: '' })
const pdf = new Uint8Array(await generate({
  template: { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[
    r('見出し', 20, 30, 40), r('記入', 60, 30, 80), t('氏名', 22, 32), t('有無', 20, 50, ), t('家族', 20, 70), t('表', 20, 90),
  ]] } as never,
  inputs: [{ 氏名: '氏名', 有無: 'ペット □有 □無', 家族: '家族の氏名', 表: '課題 1 ／ 課題 2' }],
  plugins: { text, rectangle },
  options: { font },
}))

const ask: Ask = async (prompt, _schema, meta) => {
  if (meta.step === '様式の欄') {
    const text = typeof prompt === 'string' ? prompt : prompt.map((p) => ('text' in p ? p.text : '')).join('\n')
    const cell = Number(text.match(/^(\d+): (?:59\.\d+|60(?:\.\d+)?),30/m)![1])
    return {
      slots: [
        { x: 0, y: 0, w: 1, h: 1, ui: 'text', ref: 'person.name', cell, label: '氏名', confidence: 0.9 },
        { x: 0, y: 0, w: 1, h: 1, ui: 'check', ref: 'local.pet', box: 1, mark: { kind: 'eq', value: '有' }, label: 'ペット 有', confidence: 0.9 },
        { x: 0, y: 0, w: 1, h: 1, ui: 'check', ref: 'local.pet', box: 2, mark: { kind: 'eq', value: '無' }, label: 'ペット 無', confidence: 0.9 },
        { x: 50, y: 70, w: 60, h: 5, ui: 'text', ref: 'family.members[].name', label: '家族の氏名', confidence: 0.6 },
        { x: 30, y: 96, w: 40, h: 5, ui: 'text', ref: 'local.issue[0]', label: '課題 1', confidence: 0.8 },
        { x: 80, y: 96, w: 40, h: 5, ui: 'text', ref: 'local.issue[1]', label: '課題 2', confidence: 0.8 },
      ],
      localFields: [{ key: 'local.pet', label: 'ペットの有無', type: 'enum', choices: ['有', '無'] }, { key: 'local.issue', label: '課題', type: 'longtext', note: '本人が困っていること' }],
    }
  }
  return { slots: [], fixes: [], removes: [], localFields: [] }
}

const result = await importPdf(pdf, { ask })
writeFileSync(new URL('../../../test/fixtures/form-import/result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n')
console.log(result.status, result.status === 'succeeded' ? `欄 ${Object.keys(result.draft.bindings).length}、要確認 ${result.draft.review.length}` : '')
