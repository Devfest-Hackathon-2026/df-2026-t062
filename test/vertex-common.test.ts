import assert from 'node:assert/strict'
import { test } from 'node:test'
import { atoms, candidateFields, dropAtoms, needsDocument, sentences, validateValue, valueSchema, type Spec } from '../worker/vertex/common.ts'
import { seedFormDef } from '../forms/admin/files.ts'

const specs = candidateFields(seedFormDef('assessment'))
const longtext = specs.find((s) => s.type === 'longtext' && !needsDocument(s))!
const enumSpec = specs.find((s) => s.type === 'enum' && s.choices?.length)!
const listSpec: Spec = {
  key: 'family.members', label: '家族', type: 'list', choices: null, note: null, where: '', source: ['talk'],
  subs: [{ key: 'relationship', label: '続柄', type: 'enum', choices: ['長男', '長男の妻'] }, { key: 'health', label: '健康状態', type: 'text', choices: null }],
}

test('文を分けるとき、かっこの中の「。」では分けない', () => {
  assert.deepEqual(sentences('左側に残渣あり（ST。目視）。本人は気にならない。'), ['左側に残渣あり（ST。目視）。', '本人は気にならない。'])
})

test('最後のチェックの単位を落として値を組み直す（文章は文ごと、表は行の項目ごと、全部落ちたら null）', () => {
  assert.deepEqual(atoms(longtext, 'あ。い。').map((a) => a.path), ['#0', '#1'])
  assert.equal(dropAtoms(longtext, 'あ。い。', new Set(['#1'])), 'あ。')
  assert.equal(dropAtoms(longtext, 'あ。い。', new Set(['#0', '#1'])), null)

  const rows = [{ relationship: '長男', health: '良好' }, { relationship: '長男の妻', health: '腰痛' }]
  assert.deepEqual(atoms(listSpec, rows)[0], { path: '[0]/relationship', label: '1 行目（長男）の続柄', text: '長男' })
  // 行を見分ける項目（続柄）を落とした行は、行ごと落とす
  assert.deepEqual(dropAtoms(listSpec, rows, new Set(['[0]/relationship', '[1]/health'])), [{ relationship: '長男の妻' }])
})

test('値の確かめ: 選択肢は全角半角・空白の違いを直し、ないものは落とす', () => {
  const c = enumSpec.choices![0]
  assert.deepEqual(validateValue(enumSpec, ` ${c} `), [c, []])
  const [v, problems] = validateValue(enumSpec, '選択肢にない値')
  assert.equal(v, null)
  assert.equal(problems.length, 1)
  assert.deepEqual(validateValue(listSpec, [{ relationship: '長男', health: ' ' }, { relationship: 'ちがう' }])[0], [{ relationship: '長男' }])
})

test('値の JSON Schema は、どの欄も null を許し、選択肢は enum で縛る', () => {
  const s = valueSchema(enumSpec) as { anyOf: { enum?: string[], type?: string }[] }
  assert.deepEqual(s.anyOf[0].enum, enumSpec.choices)
  assert.deepEqual(s.anyOf[1], { type: 'null' })
  const l = valueSchema(listSpec) as { anyOf: { type: string, items: { properties: Record<string, unknown> } }[] }
  assert.equal(l.anyOf[0].type, 'array')
  assert.deepEqual(Object.keys(l.anyOf[0].items.properties), ['relationship', 'health'])
})

test('書類だけが出どころの欄は、会話からは書かない欄として見分ける', () => {
  assert.equal(needsDocument({ ...longtext, source: ['doc:主治医意見書'] }), true)
  assert.equal(needsDocument({ ...longtext, source: ['doc:主治医意見書', 'talk'] }), false)
  assert.equal(needsDocument({ ...longtext, source: [] }), false)
})
