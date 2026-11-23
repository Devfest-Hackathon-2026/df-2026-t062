import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { FormDef } from '../core/form.ts'
import { expandPrintLayout } from '../core/print-layout.ts'
import { editablePages } from '../src/components/care-paper/editablePages.ts'

const form = (number: number): FormDef => {
  const root = new URL(`../forms/seed/care_plan_${number}/`, import.meta.url)
  const meta = JSON.parse(readFileSync(new URL('form.json', root), 'utf8'))
  return { ...meta, schemas: JSON.parse(readFileSync(new URL('template.json', root), 'utf8')).schemas,
    bindings: JSON.parse(readFileSync(new URL('bindings.json', root), 'utf8')) } as FormDef
}

for (const number of [2, 6]) test(`第${number}表は空の最終行まで全列を操作でき、PDFや値に架空の行を追加しない`, () => {
  const f = form(number), values = {}
  const pdf = expandPrintLayout(f, values, { checkOverflow: false })
  const before = JSON.stringify(pdf), screen = editablePages(f, values)
  const layout = f.pages[0].print!
  assert.equal(layout.type, 'table')
  if (layout.type !== 'table') return
  for (const column of layout.slots) for (let row = 0; row < layout.rowsPerPage; row++) {
    assert.ok(screen[0].schemas.some(s => s.name === `${column}__row${row}`))
  }
  assert.equal(screen.length, pdf.length)
  assert.deepEqual(values, {})
  assert.equal(JSON.stringify(expandPrintLayout(f, values, { checkOverflow: false })), before)
})

test('第3表は予定ゼロでも週間枠と生活活動の全体を操作でき、空の予定を保存しない', () => {
  const f = form(3), screen = editablePages(f, {})
  for (const name of ['週間枠', '日常生活活動']) {
    const original = f.schemas[0].find(s => s.name === name)!
    const target = screen[0].schemas.find(s => s.name === `${name}__slot100000`)!
    assert.deepEqual(target.position, original.position)
    assert.equal(target.width, original.width)
    assert.equal(target.height, original.height)
    assert.equal(screen[0].input[target.name], '')
  }
  assert.ok(!expandPrintLayout(f, {}, { checkOverflow: false })[0].schemas.some(s => s.name.includes('__slot')))
})

test('第5表の年月日・項目は左右とも本文と同じ縦範囲を操作でき、印字座標は変更しない', () => {
  const f = form(5), values = { 'progress.content': '架空の本文' }
  const screen = editablePages(f, values), content = f.schemas[0].find(s => s.name === '内容_左')!
  for (const name of ['年月日_左', '項目_左', '年月日_右', '項目_右']) {
    const target = screen[0].schemas.find(s => s.name === `${name}__empty`)!
    assert.equal(target.position.y, content.position.y)
    assert.equal(target.height, content.height)
  }
  assert.equal(screen[0].input['内容_左'], '架空の本文')
  assert.ok(!expandPrintLayout(f, values, { checkOverflow: false })[0].schemas.some(s => s.name.endsWith('__empty')))
})

test('第6表の認定・要介護区分は文字の重ね書きでなく選択した位置の丸印に割り当てる', () => {
 const f=form(6), pages=expandPrintLayout(f,{'monthly.header':{careLevel:'要介護1',certificationStatus:'認定済'}},{checkOverflow:false})
 for(const name of ['要介護状態区分_1','認定区分_認定済']) {
  assert.equal(pages[0].schemas.find(s=>s.name===name)?.type,'circleMark')
  assert.equal(pages[0].input[name],'true')
 }
 assert.equal(pages[0].input['要介護状態区分_2'],'false')
})
