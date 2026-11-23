// 確かめる画面（手順 3）の「まだ」の欄（#209 の動作確認で見つかった不具合）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewSlotNames } from '../src/components/office-add/addFlow.ts'

test('AI が同じ欄に理由を 2 つ付けても、「まだ」には 1 回だけ並ぶ（順は最初に出た順）', () => {
  const review = [
    { slot: 'p1_M', reason: '元号が分からない（M）' },
    { slot: 'p1_M', reason: '印が何を表すか分からない' },
    { slot: 'p1_T', reason: '元号が分からない（T）' },
    { slot: 'p1_T', reason: '印が何を表すか分からない' },
  ]
  assert.deepEqual(reviewSlotNames(review), ['p1_M', 'p1_T'])
})
