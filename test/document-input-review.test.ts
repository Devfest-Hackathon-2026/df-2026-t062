import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toFormDef } from '../core/form.ts'
import { unresolvedFieldKeys } from '../worker/document-input/review.ts'
import type { DocumentReadResult } from '../core/document-input.ts'

const form = toFormDef({ id: 'review', kind: 'assessment', name: '照合', version: 1, contentSha: '', pages: [], schemas: [], bindings: {
  food: { op: 'text@1', ui: 'text', ref: { key: 'survey.2_4' } }, move: { op: 'text@1', ui: 'text', ref: { key: 'survey.2_2' } },
  local: { op: 'text@1', ui: 'text', ref: { key: 'local.support' } },
}, localFields: [{ key: 'local.support', label: '連絡の方法', type: 'text', note: '緊急時の連絡' }] })
const reading = (): DocumentReadResult => ({ visit: { id: 'd', date: '不明', scenes: [] }, evidence: [], issues: [] })
test('不確かな項目と同じ見出しは、別の明瞭な特記事項があっても保留する。ほかの欄は残す', () => {
  const input = reading()
  input.evidence = [
    { id: 'unclear', page: 2, text: '４．食事摂取は複数の印', uncertain: true, recordedOn: null, region: null },
    { id: 'note', page: 3, text: '食事摂取は見守り等', uncertain: false, recordedOn: null, region: null },
  ]
  assert.deepEqual([...unresolvedFieldKeys(form, input)], ['survey.2_4'])
})
test('版の欄の辞書から事業所だけの欄も保留し、用紙にない見出しを割当てない', () => {
  const input = reading()
  input.issues = [{ page: 1, text: '連絡の方法は判読できない', labels: ['連絡の方法'] }, { page: 1, text: '未知の項目は判読できない', labels: ['未知の項目'] }]
  assert.deepEqual([...unresolvedFieldKeys(form, input)], ['local.support'])
  assert.equal(unresolvedFieldKeys(form, reading()).size, 0)
})
test('正常な項目を除外している警告文を、その項目の保留と取り違えない', () => {
  const input = reading()
  input.issues = [{ page: 1, text: '移動、食事摂取以外は未記入です' }]
  assert.deepEqual([...unresolvedFieldKeys(form, input)], [])
  input.issues.push({ page: 1, text: '印が読めません', labels: ['移動'] })
  assert.deepEqual([...unresolvedFieldKeys(form, input)], ['survey.2_2'])
})
