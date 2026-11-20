// AI 点検の採点（eval/inspect/score.ts）と、正解の叩き台（eval/inspect/gold.json）の形。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkSet } from '../core/checks/index.ts'
import { GLOBAL_DICT } from '../core/dictionary.ts'
import { applyAblation, scoreAblation, scoreLevels, type Gold } from '../eval/inspect/score.ts'

const gold = JSON.parse(readFileSync(new URL('../eval/inspect/gold.json', import.meta.url), 'utf8')) as Gold

test('正解の形: アセスメントの 32 項目すべてに、その項目の基準にある段階と理由', () => {
  const set = checkSet(gold.checkSet)
  const items = set.items.filter((i) => i.docs.includes('assessment'))
  assert.deepEqual(Object.keys(gold.levels).map(Number).sort((a, b) => a - b), items.map((i) => Number(i.id)))
  for (const i of items) {
    const g = gold.levels[i.id]
    assert.ok(i.levels[g.level], `${i.id} の段階 ${g.level} は基準にない`)
    assert.ok(g.why.length > 0)
  }
  // 消す・足す欄は fields.json にある
  for (const a of gold.ablations) for (const k of [...(a.remove ?? []), ...Object.keys(a.set ?? {})]) assert.ok(GLOBAL_DICT.get(k), `${a.id}: ${k}`)
})

test('採点: 段階の一致、要確認（1）かどうかの一致、確かな項目だけの一致', () => {
  const g: Gold['levels'] = {
    1: { level: '1', sure: true, why: '' }, 2: { level: '2', sure: true, why: '' }, 3: { level: '3', sure: false, why: '' }, 4: { level: '他', sure: true, why: '' },
  }
  const s = scoreLevels(g, new Map([['1', '1'], ['2', '3'], ['3', '1'], ['4', '2']]))
  assert.equal(s.total, 4)
  assert.equal(s.exact, 1)
  assert.equal(s.needCheck.agree, 3, '1 かどうか: 1→1、2→3、他→2 は合う。3→1 は合わない')
  assert.deepEqual(s.needCheck.missed, [], '正解が 1 なのに 2 以上にした項目')
  assert.deepEqual(s.needCheck.extra, ['3'], '正解が 2 以上なのに 1 にした項目')
  assert.deepEqual(s.sure, { total: 3, exact: 1 })
  assert.deepEqual(s.diff.map((d) => d.id), ['2', '3', '4'])
  // 判定できなかった項目は外れに数える
  assert.equal(scoreLevels(g, new Map([['1', null], ['2', '2'], ['3', '3'], ['4', '他']])).exact, 3)
})

test('欄を消す・足す: 値を変えた写しを作り、段階が下がった（上がった）かを見る', () => {
  const base = { 'complaint.person': 'a', 'health.notes': 'b', x: 1 }
  assert.deepEqual(applyAblation(base, { id: 'r', remove: ['complaint.person'], expect: {} }), { 'health.notes': 'b', x: 1 })
  assert.deepEqual(applyAblation(base, { id: 's', set: { 'health.notes': 'c' }, expect: {} }), { 'complaint.person': 'a', 'health.notes': 'c', x: 1 })
  assert.deepEqual(base, { 'complaint.person': 'a', 'health.notes': 'b', x: 1 }, '元は変えない')
  const before = new Map([['20', '3'], ['13', '1']]) as Map<string, '1' | '2' | '3' | '他' | null>
  assert.deepEqual(scoreAblation({ id: 'a', expect: { 20: 'lower' } }, before, new Map([['20', '1']])), [{ id: '20', expect: 'lower', before: '3', after: '1', ok: true }])
  assert.equal(scoreAblation({ id: 'a', expect: { 20: 'lower' } }, before, new Map([['20', '3']]))[0].ok, false)
  assert.equal(scoreAblation({ id: 'b', expect: { 13: 'higher' } }, before, new Map([['13', '2']]))[0].ok, true)
  // 他 は段階の比べ方では 2 と同じに扱う（満たしている側）
  assert.equal(scoreAblation({ id: 'c', expect: { 20: 'lower' } }, new Map([['20', '他']]), new Map([['20', '1']]))[0].ok, true)
})
