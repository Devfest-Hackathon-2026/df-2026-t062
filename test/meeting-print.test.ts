import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSeed } from '../forms/admin/files.ts'
import { expandPrintLayout } from '../core/print-layout.ts'
test('第4表: 複数出席者と長い検討内容・結論・課題を混ぜずに継続ページへ出す', () => {
  const form = readSeed('care_plan_4')
  const content = '話し合っただけでまだ決定していない事項。'.repeat(120)
  const attendees = Array.from({ length: 14 }, (_, i) => ({ id: 'attendee-' + i, name: '出席者' + i, affiliation: '架空事業所', profession: '看護師' }))
  const pages = expandPrintLayout(form, { 'meeting.attendees': attendees, 'meeting.discussion': content, 'meeting.conclusion': '合意した内容だけ', 'meeting.remaining': '未決定の課題', 'meeting.nextDate': '時期は次回調整' })
  assert.ok(pages.length > 1)
  assert.equal(pages.map(p => p.input['検討内容']).join('').replaceAll('\n',''), content)
  const printedNames = pages.flatMap(p => Object.entries(p.input).filter(([k]) => /^出席者氏名/.test(k)).map(([,v]) => v)).filter(Boolean)
  assert.deepEqual(printedNames, attendees.map(a => a.name))
  assert.equal(pages[0].input['結論'], '合意した内容だけ')
  assert.ok(!pages[0].input['結論'].includes('未決定'))
})
