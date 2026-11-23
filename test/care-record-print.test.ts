import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSeed } from '../forms/admin/files.ts'
import { expandPrintLayout } from '../core/print-layout.ts'

test('第5表: 長文は公式様式の左列→右列→継続ページへ、省略せず展開する', () => {
  const form = readSeed('care_plan_5')
  const content = '本人の発言を確認した。未決定事項は次回確認する。'.repeat(140)
  const pages = expandPrintLayout(form, { 'progress.content': content, 'progress.date': '2026-11-22', 'progress.category': '電話（受信）' })
  assert.ok(pages.length > 1)
  const printed = pages.flatMap(p => ['内容_左', '内容_右'].map(n => p.input[n])).join('').replaceAll('\n', '')
  assert.equal(printed, content)
  assert.ok(pages.every(p => p.input['項目_左'] === '電話（受信）'))
  assert.ok(pages.every(p => p.input.__continuation_page))
})

import { checkVersion } from '../db/forms.ts'
test('継続領域は同じ入力値・寸法のtext欄だけに限定する', () => {
  const form = readSeed('care_plan_5')
  assert.deepEqual(checkVersion(form), [])
  form.bindings['内容_右'] = { op: 'text@1', ui: 'area', ref: { key: 'progress.category' } }
  assert.ok(checkVersion(form).some(x => x.includes('対応が不一致')))
  form.schemas[0].find(s => s.name === '内容_右')!.width = 20
  assert.ok(checkVersion(form).some(x => x.includes('寸法が不一致')))
})
