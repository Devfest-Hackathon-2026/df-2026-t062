// 責任者の画面で、欄に「何が入るか」を言葉で出す・言葉で直す（#102）。DB を使わない部分。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Binding } from '../core/binding.ts'
import { fieldDict } from '../core/dictionary.ts'
import { FIELD_LIST, subFieldsOf } from '../core/fields.ts'
import { bindingFromMatch, fakeFieldMatcher, fieldCandidates, isMarkSlot, localFieldFor, slotMeaning } from '../core/slot-meaning.ts'

const scalar = FIELD_LIST.find((f) => f.type === 'text' && !f.key.startsWith('local.'))!
const list = FIELD_LIST.find((f) => f.type === 'list' && subFieldsOf(f).some((s) => s.type === 'text'))!
const sub = subFieldsOf(list).find((s) => s.type === 'text')!
const enumField = FIELD_LIST.find((f) => f.type === 'enum' && Array.isArray(f.choices) && f.choices.length >= 2)!
const boolField = FIELD_LIST.find((f) => f.type === 'bool')!

test('入る内容の言葉: 欄の名前。行の中の項目は「何行目の何」。丸・✓ は「どの値のとき」（印の欄だと分かる）', () => {
  const dict = fieldDict([{ key: 'local.pet', label: 'ペットの有無', type: 'enum', choices: ['有', '無'], note: 'ペットの話' }])
  assert.equal(slotMeaning({ op: 'text@1', ui: 'text', ref: { key: scalar.key } }, dict).what, scalar.label)
  assert.equal(slotMeaning({ op: 'text@1', ui: 'text', ref: { key: list.key, path: [1, sub.key] } }, dict).what, `${list.label}（2 行目）の${sub.label}`)
  const choice = (enumField.choices as string[])[1]
  assert.deepEqual(slotMeaning({ op: 'option@1', ui: 'check', ref: { key: enumField.key }, is: { eq: choice } }, dict), { what: `${enumField.label}が「${choice}」`, rec: slotMeaning({ op: 'text@1', ui: 'text', ref: { key: enumField.key } }, dict).rec, mark: true })
  assert.equal(slotMeaning({ op: 'option@1', ui: 'check', ref: { key: boolField.key }, is: { eq: true } }, dict).what, boolField.label)
  assert.equal(slotMeaning({ op: 'text@1', ui: 'text', ref: { key: 'local.pet' } }, dict).what, 'ペットの有無')
  assert.equal(slotMeaning({ op: 'text@1', ui: 'text', ref: { key: 'local.pet' } }, dict).rec, true, '説明書きのある、その様式だけの欄は録音から書く')
  assert.equal(slotMeaning({ op: 'text@1', ui: 'text', ref: { key: 'local.nothing' } }, dict).what, '（分からない欄）')
})

test('当てはめの候補: 文字の欄には文字で出せる欄、丸・✓ の欄には選ぶ欄。行の中の項目も出す。その様式だけの欄も入る', () => {
  const local = [{ key: 'local.pet', label: 'ペットの有無', type: 'enum' as const, choices: ['有', '無'] }]
  const text = fieldCandidates(false, local)
  assert.ok(text.some((c) => c.id === scalar.key))
  assert.ok(text.some((c) => c.id === `${list.key}[].${sub.key}` && c.list))
  assert.ok(text.some((c) => c.id === 'local.pet'))
  assert.ok(!text.some((c) => c.type === 'image' || c.type === 'list' || c.type === 'object'))
  const mark = fieldCandidates(true, local)
  assert.ok(mark.every((c) => c.type === 'enum' || c.type === 'multi' || c.type === 'bool'))
  assert.ok(mark.some((c) => c.id === boolField.key))
})

test('当てはめから対応を作る: 文字の欄は text@1（行は番号に直す）。丸・✓ は値の条件つき。元の欄の見せ方は変えない', () => {
  const prev: Binding = { op: 'text@1', ui: 'area', ref: { key: scalar.key } }
  assert.deepEqual(bindingFromMatch({ id: scalar.key }, { mark: false, height: 8, prev }, []), { op: 'text@1', ui: 'area', ref: { key: scalar.key } })
  assert.deepEqual(bindingFromMatch({ id: `${list.key}[].${sub.key}`, row: 2 }, { mark: false, height: 8 }, []), { op: 'text@1', ui: 'text', ref: { key: list.key, path: [1, sub.key] } })
  assert.equal((bindingFromMatch({ id: scalar.key }, { mark: false, height: 30 }, []) as { ui: string }).ui, 'area', '高い欄は何行も書ける')
  const choice = (enumField.choices as string[])[0]
  assert.deepEqual(bindingFromMatch({ id: enumField.key, choice }, { mark: true, height: 4, prev: { op: 'option@1', ui: 'circle', ref: { key: 'x' }, is: { eq: 1 } } }, []),
    { op: 'option@1', ui: 'circle', ref: { key: enumField.key }, is: { eq: choice } })
  assert.deepEqual(bindingFromMatch({ id: boolField.key }, { mark: true, height: 4 }, []), { op: 'option@1', ui: 'check', ref: { key: boolField.key }, is: { eq: true } })
  assert.equal(bindingFromMatch({ id: enumField.key }, { mark: true, height: 4 }, []), null, '選ぶ欄で、どの値か分からなければ当てない')
  assert.equal(bindingFromMatch({ id: enumField.key, choice: 'ない値' }, { mark: true, height: 4 }, []), null)
  assert.equal(bindingFromMatch({ id: 'ない.key' }, { mark: false, height: 8 }, []), null)
})

test('fields.json になければ、その様式だけの欄を作る（名前と説明は書いた言葉。key は重ならない）', () => {
  const have = [{ key: 'local.custom_1', label: '前のもの', type: 'text' as const }]
  const t = localFieldFor('  ペットの名前  ', { mark: false, height: 8 }, have)
  assert.deepEqual(t, { key: 'local.custom_2', label: 'ペットの名前', type: 'text', note: 'ペットの名前' })
  assert.equal(localFieldFor('ふだんの様子', { mark: false, height: 40 }, []).type, 'longtext')
  assert.equal(localFieldFor('喫煙あり', { mark: true, height: 4 }, []).type, 'bool')
})

test('試しの当てはめ（AI なし）: 書いた言葉に欄の名前が入っていれば、いちばん長い名前の欄。行の番号と選ぶ値も読む', async () => {
  const candidates = fieldCandidates(false, [])
  assert.deepEqual(await fakeFieldMatcher({ text: `${scalar.label}を書く`, mark: false, candidates }), { id: scalar.key })
  assert.deepEqual(await fakeFieldMatcher({ text: `${list.label}の${sub.label}（3 行目）`, mark: false, candidates }), { id: `${list.key}[].${sub.key}`, row: 3 })
  assert.equal(await fakeFieldMatcher({ text: 'どこにもない言葉ですよ', mark: false, candidates }), null)
  const choice = (enumField.choices as string[])[1]
  assert.deepEqual(await fakeFieldMatcher({ text: `${enumField.label}が${choice}`, mark: true, candidates: fieldCandidates(true, []) }), { id: enumField.key, choice })
})

test('丸・✓ の欄か: 対応が丸・✓、または印字欄が丸の印', () => {
  assert.equal(isMarkSlot({ type: 'text' }, { op: 'option@1', ui: 'check', ref: { key: 'a' }, is: { eq: true } }), true)
  assert.equal(isMarkSlot({ type: 'circleMark' }, undefined), true)
  assert.equal(isMarkSlot({ type: 'text' }, { op: 'text@1', ui: 'text', ref: { key: 'a' } }), false)
})
