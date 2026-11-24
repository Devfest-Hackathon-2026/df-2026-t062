// 書類を作るときに AI が書く（#195）の、プログラムが決める部分: どの欄を AI に渡すか・欄に何字入るか・はみ出すか・最後の確かめで切っただけか。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fillTargets, isCut, overflowKeys } from '../core/fill.ts'
import { seedFormDef } from '../forms/admin/files.ts'

const admission = seedFormDef('admission')
const ai = (value: unknown) => ({ value, by: 'ai' as const })

test('書く欄: 写した文字の欄は渡し、写した日付・選択肢・はい／いいえ・数の欄は渡さない（書き直させない）', () => {
  const current = {
    'person.lifeHistory': ai('長い生活歴'), 'person.birthDate': ai('1940-01-02'), 'cert.careLevel': ai('要介護2'),
    'housing.elevator': ai(true), 'housing.stories': ai(2),
  }
  const keys = fillTargets(admission, current, new Set(Object.keys(current))).map((t) => t.key)
  assert.ok(keys.includes('person.lifeHistory'))
  for (const k of ['person.birthDate', 'cert.careLevel', 'housing.elevator', 'housing.stories']) assert.ok(!keys.includes(k), k)
})

test('書く欄: 空の日付・選択肢・はい／いいえ・数の欄は渡す', () => {
  const keys = fillTargets(admission, {}, new Set()).map((t) => t.key)
  for (const k of ['person.birthDate', 'cert.careLevel', 'housing.elevator', 'housing.stories']) assert.ok(keys.includes(k), k)
})

test('書く欄: ケアマネが書いた欄・出来事の欄（入院日など）・事業所の設定の欄は渡さない', () => {
  const keys = fillTargets(admission, { 'person.lifeHistory': { value: '手で書いた', by: 'cm' } }, new Set()).map((t) => t.key)
  for (const k of ['person.lifeHistory', 'admission.date', 'admission.hospitalName', 'office.name']) assert.ok(!keys.includes(k), k)
})

test('書く欄: 写した値には印が付き、印字欄の名前とページと、入るおよその文字数が付く', () => {
  const t = fillTargets(admission, { 'person.lifeHistory': ai('長い生活歴') }, new Set(['person.lifeHistory'])).find((x) => x.key === 'person.lifeHistory')!
  assert.equal(t.copied, true)
  assert.equal(t.slot, '3_生活歴')
  assert.equal(t.page, 1)
  // 幅 135mm・高さ 6.3mm・最小 5pt: 1 行 75 字 × 2 行（PDF のはみ出しの確かめと同じ計算）
  assert.equal(t.chars, 150)
})

test('書く欄: その様式だけの欄（local.*）は、note がなくても渡す（#152 と同じ）', () => {
  const form = { ...admission, keys: [...admission.keys, 'local.memo'], localFields: [{ key: 'local.memo', label: '連絡メモ', type: 'text' as const }],
    bindings: { ...admission.bindings, memo: { op: 'text@1' as const, ui: 'text' as const, ref: { key: 'local.memo' } } } }
  assert.ok(fillTargets(form, {}, new Set()).some((t) => t.key === 'local.memo'))
})

test('はみ出し: 欄に入る字数を 1 字でも超えた文字の欄を挙げる', () => {
  assert.deepEqual([...overflowKeys(admission, { 'person.lifeHistory': 'あ'.repeat(150) })], [])
  assert.deepEqual([...overflowKeys(admission, { 'person.lifeHistory': 'あ'.repeat(151) })], ['person.lifeHistory'])
})

test('最後の確かめ: 前の文から切っただけなら通し、語を足したり変えたりしたら通さない', () => {
  const before = '妻と二人暮らし。長男は県外に住む。週 1 回電話がある。'
  assert.equal(isCut('妻と二人暮らし。週1回電話がある。', before), true, '空白の違いは問わない')
  assert.equal(isCut(before, before), true)
  assert.equal(isCut('妻と二人暮らし。長女は県外に住む。', before), false, '語を変えた')
  assert.equal(isCut('妻と二人暮らし。毎日電話がある。', before), false, '語を足した')
  assert.equal(isCut(null, before), true, '全部切るのはよい')
  assert.equal(isCut('要介護2', '要介護2'), true)
  assert.equal(isCut('要介護3', '要介護2'), false)
})
