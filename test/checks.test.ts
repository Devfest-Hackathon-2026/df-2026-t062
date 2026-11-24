// AI 点検の物差し（core/checks/）。docs/再設計/16_書類と点検の基盤.md の「物差し」「点検できる範囲」。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { categoryCounts, checkSet, checkSetSha, DEFAULT_CHECK_SET, inspectableItems, isSatisfied, verdictOf, type Level } from '../core/checks/index.ts'
import { RULES, withinPeriod } from '../core/checks/rules.ts'
import { GLOBAL_DICT } from '../core/dictionary.ts'

const set = checkSet(DEFAULT_CHECK_SET)
const byId = new Map(set.items.map((i) => [i.id, i]))

test('物差しの形: 62 項目（1〜62 の順）。出典があり、名前と版で引ける', () => {
  assert.equal(DEFAULT_CHECK_SET, 'mhlw-careplan@2026-03')
  assert.equal(set.items.length, 62)
  assert.deepEqual(set.items.map((i) => i.id), Array.from({ length: 62 }, (_, n) => String(n + 1)))
  assert.match(set.source.url, /^https:\/\/www\.mhlw\.go\.jp\//)
  assert.throws(() => checkSet('mhlw-careplan@1999-01'))
  // 中身の指紋は 16 桁。同じ中身なら同じ
  assert.match(checkSetSha(set), /^[0-9a-f]{16}$/)
  assert.equal(checkSetSha(set), checkSetSha(checkSet(DEFAULT_CHECK_SET)))
})

test('物差しの形: 書類ごとの数（アセスメント 32・第1表 2・第2表 9・第3表 4・第4表 7・第5表 3・第5表かモニタリング 3・その他 2）', () => {
  const count = (pred: (docs: string[]) => boolean) => set.items.filter((i) => pred(i.docs)).length
  assert.equal(count((d) => d.join() === 'assessment'), 32)
  assert.equal(count((d) => d.join() === 'care_plan_1'), 2)
  assert.equal(count((d) => d.join() === 'care_plan_2'), 9)
  assert.equal(count((d) => d.join() === 'care_plan_3'), 4)
  assert.equal(count((d) => d.join() === 'care_plan_4'), 7)
  assert.equal(count((d) => d.join() === 'care_plan_5'), 3)
  assert.equal(count((d) => d.join() === 'care_plan_5,monitoring'), 3)
  assert.equal(count((d) => d.length === 0), 2)
})

test('物差しの形: どの項目にも段階 1 と 2 の基準があり、段階は 1・2・3・他 だけ。観点（①②…）は順に並ぶ', () => {
  const marks = '①②③④⑤⑥⑦⑧⑨⑩'
  for (const i of set.items) {
    assert.ok(i.levels['1'] && i.levels['2'], `${i.id} ${i.name}`)
    for (const k of Object.keys(i.levels)) assert.ok(['1', '2', '3', '他'].includes(k), `${i.id}: ${k}`)
    assert.deepEqual(i.criteria.map((c) => c.mark), [...marks.slice(0, i.criteria.length)], `${i.id} の観点`)
  }
  assert.equal(byId.get('7')!.criteria.length, 8)
  assert.deepEqual(Object.keys(byId.get('18')!.levels).sort(), ['1', '2', '他'])
})

test('分類: ツールの「分類」の列のとおり。アセスメントの 32 項目は 5 つ（生活の全体像 13・疾病・心身 10・主訴 3・課題の分析 4・家族 2）', () => {
  const cats = (ids: number[]) => ids.map((n) => byId.get(String(n))!.category)
  const of = (name: string) => set.items.filter((i) => i.docs.includes('assessment') && i.category === name).map((i) => Number(i.id))
  assert.deepEqual(of('生活の全体像の把握'), [6, 7, 10, 11, 12, 15, 16, 19, 21, 22, 23, 26, 31])
  assert.deepEqual(of('疾病・心身状態の把握'), [2, 3, 4, 5, 8, 9, 13, 14, 17, 18])
  assert.deepEqual(of('主訴・意思の把握・尊重'), [20, 24, 27])
  assert.deepEqual(of('課題の分析'), [1, 28, 29, 32])
  assert.deepEqual(of('家族の状況の把握と支援'), [25, 30])
  assert.deepEqual([...new Set(set.items.map((i) => i.category))].sort(), [
    'その他', '主訴・意思の把握・尊重', '多職種との連携', '家族の状況の把握と支援', '生活の全体像の把握', '疾病・心身状態の把握', '課題の分析', '課題を解決するためのサービス計画',
  ].sort())
  // 運営基準の印（●）はケアプランの項目だけ
  assert.deepEqual(set.items.filter((i) => i.operational).map((i) => Number(i.id)), [42, 43, 48, 51, 52, 53, 55, 56, 57, 58])
  assert.deepEqual(cats([1]), ['課題の分析'])
})

test('先に見る欄（keys）は、fields.json にある欄だけ。用紙に決まった欄がない項目（水分量・BMI・使える費用・本人の役割）は空', () => {
  for (const i of set.items) for (const k of i.keys) assert.ok(GLOBAL_DICT.get(k), `${i.id} ${i.name}: ${k}`)
  for (const id of ['10', '11', '13', '26', '27']) assert.deepEqual(byId.get(id)!.keys, [], id)
  assert.equal(byId.get('31')!.keys[0], 'family.genogram')
  // アセスメントの項目には説明（AI の指示文に使う）がある
  for (const i of set.items.filter((x) => x.docs.includes('assessment'))) assert.ok(i.guide.length >= 20, `${i.id} の説明`)
})

test('判定のしかた: プログラム（rule）か両方（both）の項目には関数があり、関数のある項目は rule か both', () => {
  for (const i of set.items) {
    if (i.method !== 'ai') assert.equal(typeof RULES[i.id], 'function', `${i.id} ${i.name}`)
  }
  for (const id of Object.keys(RULES)) assert.notEqual(byId.get(id)!.method, 'ai', id)
  assert.equal(byId.get('13')!.method, 'rule')
  assert.equal(byId.get('31')!.method, 'both')
  assert.equal(byId.get('37')!.method, 'both')
})

const ruleInput = (values: Record<string, unknown>, text = '') => ({ values, text })
/** 段階を返したときの段階（観点だけ・null なら undefined） */
const levelOf = (r: ReturnType<typeof RULES[string]>) => (r && 'level' in r ? r.level : undefined)

test('プログラムで判定: 13 BMI は数字が書いてあれば 2。身長・体重だけでは 1（足りない情報つき）', () => {
  const bmi = RULES['13']
  assert.deepEqual(bmi(ruleInput({ 'health.height': 160, 'health.weight': 50 }, '身長（cm）: 160\n体重（kg）: 50')), { level: '1', missing: 'BMI の数字が書かれていない' })
  assert.equal(levelOf(bmi(ruleInput({}, '健康の特記: BMI 19.5。やせ気味'))), '2')
  assert.equal(levelOf(bmi(ruleInput({}, '健康の特記: ＢＭＩ：２２'))), '2', '全角でも読む')
  assert.equal(levelOf(bmi(ruleInput({}, '健康の特記: BMI は測っていない'))), '1', '数字がなければ 1')
})

test('プログラムで判定: 31 家族構成図がなければ 1。あれば AI に任せる（エコマップの有無は図を読む）', () => {
  assert.deepEqual(RULES['31'](ruleInput({})), { level: '1', missing: '家族構成図がない' })
  assert.equal(RULES['31'](ruleInput({ 'family.genogram': { svg: '<svg/>' } })), null)
})

test('プログラムで判定: 37 の ③ 長期目標の期間は、開始日・終了日とも認定の有効期間の中か', () => {
  const cert = { from: '2026-01-01', to: '2026-12-31' }
  assert.equal(withinPeriod('2026/1/1〜2026/6/30', cert), true)
  assert.equal(withinPeriod('令和8年1月1日～令和8年12月31日', cert), true)
  assert.equal(withinPeriod('R8.4.1-R9.3.31', cert), false, '終わりが有効期間の外')
  assert.equal(withinPeriod('2025/12/1〜2026/6/30', cert), false, '始まりが有効期間の外')
  assert.equal(withinPeriod('6か月', cert), null, '日付が読めなければ決めない（AI に任せる）')
  const r = RULES['37'](ruleInput({
    'cert.validFrom': '2026-01-01', 'cert.validTo': '2026-12-31',
    'plan.needs': [{ longGoalPeriod: '2026/1/1〜2026/6/30' }, { longGoalPeriod: '2026/1/1〜2027/1/31' }],
  }))
  assert.deepEqual(r, { met: { '③': false } }, '1 つでも外なら ③ は当たらない。段階は AI が決める')
  assert.equal(RULES['37'](ruleInput({ 'plan.needs': [{ longGoalPeriod: '2026/1/1〜2026/6/30' }] })), null, '有効期間がなければ決めない')
})

test('点検できる範囲: 利用者にある書類の種類で決まる。今はアセスメントの 32 項目だけ（第1〜5表の 30 項目は点検していない）', () => {
  assert.deepEqual(inspectableItems(set, new Set(['assessment', 'admission'])).map((i) => Number(i.id)), Array.from({ length: 32 }, (_, n) => n + 1))
  assert.deepEqual(inspectableItems(set, new Set(['admission'])), [])
  assert.deepEqual(inspectableItems(set, new Set(['care_plan_1'])).map(({ id }) => id), ['33', '34'])
  assert.deepEqual(inspectableItems(set, new Set(['monitoring'])).map(({ id }) => id), ['58', '59', '60'])
  assert.deepEqual(inspectableItems(set, new Set(['other'])), [])
})

test('書類の判定: 段階 1 が 1 つでもあれば要確認、どれも 2 以上なら適合。「他」は満たしている側に数える', () => {
  const v = (...ls: Level[]) => verdictOf(ls)
  assert.equal(v('2', '3', '他'), '適合')
  assert.equal(v('2', '1', '他'), '要確認')
  assert.equal(isSatisfied('他'), true)
  assert.equal(isSatisfied('1'), false)
})

test('分類ごとの数: アセスメントの 5 つの分類の順に、満たしている項目の数 / 項目の数', () => {
  const items = inspectableItems(set, new Set(['assessment']))
  const levels = new Map<string, Level>(items.map((i) => [i.id, '2']))
  levels.set('10', '1').set('13', '1').set('18', '他')
  assert.deepEqual(categoryCounts(items, levels), [
    { category: '生活の全体像の把握', satisfied: 12, total: 13 },
    { category: '疾病・心身状態の把握', satisfied: 9, total: 10 },
    { category: '主訴・意思の把握・尊重', satisfied: 3, total: 3 },
    { category: '課題の分析', satisfied: 4, total: 4 },
    { category: '家族の状況の把握と支援', satisfied: 2, total: 2 },
  ])
})

test('期間判定は存在しない日付・逆転・一部の目標だけの期間を適合扱いしない',()=>{
 const cert={from:'2026-01-01',to:'2026-12-31'}
 assert.equal(withinPeriod('2026/2/31〜2026/3/31',cert),null)
 assert.equal(withinPeriod('2026/6/30〜2026/4/1',cert),false)
 assert.equal(withinPeriod('2026/1/1〜2026/12/31',{from:'2026-02-31',to:'2026-12-31'}),null)
 assert.equal(RULES['37'](ruleInput({'cert.validFrom':cert.from,'cert.validTo':cert.to,'plan.needs':[{longGoalPeriod:'2026/1/1〜2026/6/30'},{longGoalPeriod:''}]})),null)
})
