// 事業所が直せる項目（#115）の共通の決まり。DB を使わない。
// docs/再設計/17_録音からの書き込み.md の「事業所が直せる項目」。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { editOfficeTopics, settleTeach, topicsFor, trainingItems, type Topic } from '../core/topics.ts'

const BASE: Topic[] = [
  { id: 'basic', name: '基本情報', guide: '受付と本人のこと', by: 'ai', last: false, section: '基本情報' },
  { id: 'health', name: '健康状態', guide: '病名と薬', by: 'ai', last: false, section: '課題分析' },
  { id: 'eating', name: '食事摂取の状況', guide: '食事の形と量', by: 'ai', last: false, section: '課題分析' },
  { id: 'overall', name: '全体のまとめ', guide: '全体', by: 'ai', last: true },
  { id: 'date', name: 'その日の日付', guide: '', by: 'machine', last: false, keys: { first: 'a.first', later: 'a.later' } },
]

test('録音の処理の一覧: 足した項目への書き足しも、その項目の説明のあとに足す。何行あっても全部渡す', () => {
  const merged = topicsFor(BASE, {
    added: [{ id: 'o1', name: 'ペット', guide: 'ペットの有無' }],
    notes: { o1: '世話をしている人も書く', health: '水分の量は数字のまま書く\n薬の飲み忘れも書く' },
  })
  assert.equal(merged.find((t) => t.id === 'o1')!.guide, 'ペットの有無 世話をしている人も書く')
  assert.match(merged.find((t) => t.id === 'health')!.guide, /水分の量は数字のまま書く[\s\S]*薬の飲み忘れも書く/)
})

test('直しの受け付け: 一覧にない項目・機械の項目への書き足しは断る。全体の項目と同じ id の足しも断る', () => {
  assert.match(editOfficeTopics(BASE, { added: [], notes: { ghost: ['書いて'] }, passed: [] }).error ?? '', /ghost/)
  assert.match(editOfficeTopics(BASE, { added: [], notes: { date: ['書いて'] }, passed: [] }).error ?? '', /date/)
  assert.match(editOfficeTopics(BASE, { added: [{ id: 'health', name: '乗っ取り', guide: '' }], notes: {}, passed: [] }).error ?? '', /health/)
  assert.ok(editOfficeTopics(BASE, { added: [{ id: 'o1', name: 'ペット', guide: '' }], notes: { o1: ['世話をする人'] }, passed: [] }).value, '足した項目には書き足せる')
})

test('直しの受け付け: 新しく足す項目には重ならない id を振る。空の行は捨てる。消した項目の合格の印は残さない', () => {
  const r = editOfficeTopics(BASE, {
    added: [{ id: 'o1', name: 'ペット', guide: 'ペットの有無' }, { name: '趣味', guide: '' }],
    notes: { health: ['  水分の量は数字で  ', '', '   '] },
    passed: ['basic', 'gone', 'o1'],
  })
  const v = r.value!
  assert.equal(v.added[0].id, 'o1')
  assert.notEqual(v.added[1].id, 'o1')
  assert.deepEqual(v.notes, { health: '水分の量は数字で' })
  assert.deepEqual(v.passed, ['basic', 'o1'])
})

test('直しの受け付け: 消した項目の id を、新しく足す項目に使い回さない（前の要約が新しい項目のものにならないように）', () => {
  const first = editOfficeTopics(BASE, { added: [{ name: 'ペット', guide: '' }], notes: {}, passed: [] }).value!.added[0].id
  const again = editOfficeTopics(BASE, { added: [{ name: '趣味', guide: '' }], notes: {}, passed: [] }).value!.added[0].id
  assert.notEqual(again, first)
})

test('特訓の項目: AI がまとめる項目だけを出す（全体のまとめ・日付は出さない）。消せるのは事業所の項目だけ', () => {
  const items = trainingItems(BASE, { added: [{ id: 'o1', name: 'ペット', guide: 'ペットの有無' }], notes: { health: 'a\nb' }, passed: ['basic'] }, { ownKind: false })
  assert.deepEqual(items.map((i) => [i.id, i.origin, i.removable, i.passed]), [
    ['basic', 'standard', false, true], ['health', 'standard', false, false], ['eating', 'standard', false, false], ['o1', 'added', true, false],
  ])
  assert.deepEqual(items.find((i) => i.id === 'health')!.notes, ['a', 'b'])
  assert.equal(items.find((i) => i.id === 'health')!.guide, '病名と薬', '書き足しは説明に混ぜずに返す（取り消せるように）')
  const own = trainingItems(BASE, null, { ownKind: true })
  assert.ok(own.every((i) => i.origin === 'office' && i.removable), '事業所が足した書類の項目は、AI が作ったものなので消せる')
})

test('AI の振り分け: 一覧にない項目を指したら、新しい項目にする。聞き返しの選択肢から、ない項目を外す', () => {
  const items = [{ id: 'health', name: '健康状態', guide: '' }, { id: 'eating', name: '食事摂取の状況', guide: '' }]
  assert.deepEqual(settleTeach(items, { type: 'note', topicId: 'health', line: ' 水分の量は数字で ' }, '水分の量は数字で'), { type: 'note', topicId: 'health', line: '水分の量は数字で' })
  assert.deepEqual(settleTeach(items, { type: 'note', topicId: 'ghost', line: 'ペットのこと' }, 'ペットのことも'), { type: 'new', name: 'ペットのこと', guide: 'ペットのこと' })
  const ask = settleTeach(items, { type: 'ask', question: 'どちら？', options: [{ label: 'A', topicId: 'health', line: 'x' }, { label: 'B', topicId: 'ghost', line: 'y' }] }, '等級')
  assert.deepEqual(ask.type === 'ask' && ask.options.map((o) => o.topicId), ['health'])
  const none = settleTeach(items, { type: 'ask', question: 'どちら？', options: [{ label: 'B', topicId: 'ghost', line: 'y' }] }, '等級も')
  assert.deepEqual(none, { type: 'new', name: '等級も', guide: '等級も' }, '選べる項目が残らなければ、新しい項目にする')
  assert.equal(settleTeach(items, { type: 'refuse', message: '話に出ていないことは書けません' }, 'それらしく埋めて').type, 'refuse')
})
