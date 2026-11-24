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
test('ページ全体の問題は「まだ」の欄に表示せず、実在する欄だけを並べる（#256）', () => {
  const review = [
    { slot: '', reason: '1 ページ: 読み取りに失敗しました' },
    { slot: 'p1_氏名', reason: '入る内容を確認してください' },
    { slot: '', reason: '2 ページ: 読み取りに失敗しました' },
    { slot: 'p1_氏名', reason: '別の確認理由' },
    { slot: '  ', reason: '欄名が空白だけ' },
    { slot: 'p1_住所', reason: '住所の対応を確認してください' },
  ]

  assert.deepEqual(reviewSlotNames(review), ['p1_氏名', 'p1_住所'])
})
test('PDFに存在しないreview slotは確認対象から除外する（#256）', () => {
  const review = [
    { slot: '', reason: 'ページ全体の読み取りエラー' },
    { slot: 'p1_氏名', reason: '氏名を確認してください' },
    { slot: 'p3_存在しない欄', reason: '対応先がありません' },
    { slot: 'p1_住所', reason: '住所を確認してください' },
    { slot: 'p1_氏名', reason: '別の確認理由' },
  ]

  const validSlots = new Set(['p1_氏名', 'p1_住所'])

  assert.deepEqual(
    reviewSlotNames(review, validSlots),
    ['p1_氏名', 'p1_住所']
  )
})