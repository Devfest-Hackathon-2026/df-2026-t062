import assert from 'node:assert/strict'
import { test } from 'node:test'
import { score } from '../eval/document-import/run.ts'
import { ZERO_USAGE } from '../worker/types.ts'
import type { DocumentInputResult } from '../core/document-input.ts'

const empty = (): DocumentInputResult => ({ visit: { id: 'x', date: '不明', scenes: [] }, evidence: [], issues: [], candidates: [], incompleteFields: [], usage: ZERO_USAGE })
test('書類評価は欠落と誤候補を分け、複数選択の順序差を誤りと数えない', () => {
  const input = empty()
  input.candidates = [
    { key: 'survey.2_2', value: '全介助', base: null, cite: [] },
    { key: 'survey.1_1', value: ['左上肢', '右上肢'], base: null, cite: [] },
  ]
  const result = score(input, [
    { key: 'survey.2_2', expected: '見守り等', review: false },
    { key: 'survey.2_4', expected: '見守り等', review: false },
    { key: 'survey.1_1', expected: ['右上肢', '左上肢'], review: false },
  ])
  assert.equal(result.exact, 1)
  assert.equal(result.wrong, 1)
  assert.equal(result.missing, 1)
})
test('無関係な要確認記録を、評価対象の曖昧な印の安全な保留と取り違えない', () => {
  const input = empty()
  input.issues = [{ page: 2, text: '食事摂取の印が複数あります' }]
  const gold = [{ key: 'survey.2_2', expected: '見守り等', review: true }]
  assert.equal(score(input, gold).safeReview, 0)
  input.issues.push({ page: 2, text: '2-2の印が薄いです' })
  assert.equal(score(input, gold).safeReview, 1)
})
test('存在しない根拠と判読不確実な根拠を追跡可能な候補と数えない', () => {
  const input = empty()
  input.evidence = [{ id: 'faint', page: 2, text: '薄い印', recordedOn: null, region: null, uncertain: true }]
  input.candidates = [{ key: 'survey.2_2', value: '見守り等', base: null, cite: ['faint'] }]
  assert.equal(score(input, []).withEvidence, 0)
  input.candidates[0].cite = ['missing']
  assert.equal(score(input, []).withEvidence, 0)
  assert.equal(score(empty(), []).evidenceCoverage, null)
})
