// 様式の取り込み（#99）の、AI を呼ばない部分: key の一覧、ページの文字一覧、マスと □、答えの当て方、手で作った版との比べ方。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogLines, pageText } from '../worker/form-import/prompt.ts'
import { findBoxes, findCells, placeInBoxes, placeInCells, unusedBoxes } from '../worker/form-import/geometry.ts'
import { addMissing, applyReview, defaultMarks, fixLocalPrefix, flattenLocalRows, mergeLocalFields, type DraftSlot } from '../worker/form-import/draft.ts'
import { checkBudget, compareDraft, handMark, handRef, handRefs, spentYen } from '../forms/tools/import/compare.ts'

test('key の一覧: 書く場所（forms）や AI 向けの note は入れず、型の中の欄と選択肢は展開する', () => {
  const fields = {
    choiceSets: { 有無: ['あり', 'なし'] },
    types: { Contact: { label: '連絡先つきの人', fields: [{ key: 'name', label: '氏名', type: 'text' }, { key: 'sex', label: '性別', type: 'enum', choices: ['男', '女'] }] } },
    fields: [
      { group: '受付' },
      { key: 'intake.method', label: '相談受付の方法', type: 'enum', choices: ['訪問', '電話'], forms: { assess: 'p.1 上' }, note: 'AI へのヒント' },
      { key: 'x.has', label: '有無の欄', type: 'enum', choices: '有無' },
      { key: 'emergencyContact', label: '緊急連絡先', type: 'object', of: 'Contact' },
      { key: 'family.members', label: '家族', type: 'list', of: 'Contact' },
    ],
  }
  const lines = catalogLines(fields)
  assert.deepEqual(lines, [
    'intake.method｜相談受付の方法｜enum｜訪問/電話',
    'x.has｜有無の欄｜enum｜あり/なし',
    'emergencyContact.name｜緊急連絡先 の 氏名｜text',
    'emergencyContact.sex｜緊急連絡先 の 性別｜enum｜男/女',
    'family.members[].name｜家族 の 氏名｜text',
    'family.members[].sex｜家族 の 性別｜enum｜男/女',
  ])
  assert.ok(!lines.join().includes('p.1'), '書く場所は渡さない（答えになるので）')
})

test('ページの文字一覧: 同じ高さの語を 1 行にまとめ、座標は 0.1mm に丸める。短い罫線は省く', () => {
  const page = {
    width: 210, height: 297,
    words: [
      { t: '氏名', x0: 20.04, y0: 30.01, x1: 26.0, y1: 33.0 },
      { t: '性別', x0: 80.0, y0: 30.2, x1: 86.0, y1: 33.1 },
      { t: '住所', x0: 20.0, y0: 40.0, x1: 26.0, y1: 43.0 },
    ],
    // layout.json の罫線は [y, x0, x1]・[x, y0, y1]。四角の上下の辺のように同じ線が 2 本並ぶものは 1 本にする
    hlines: [[35.04, 10, 200], [35.06, 10, 200], [50, 10, 12]] as [number, number, number][],
    vlines: [[50, 28, 45]] as [number, number, number][],
  }
  assert.equal(pageText(page), [
    'ページ 210×297mm',
    '文字（行ごと。各語は 語@x0,y0-x1,y1）',
    '氏名@20,30-26,33 性別@80,30.2-86,33.1',
    '住所@20,40-26,43',
    '横の罫線（y: x0-x1）',
    '35: 10-200',
    '縦の罫線（x: y0-y1）',
    '50: 28-45',
  ].join('\n'))
})

test('手で作った対応を、比べる用の短い形にする（家族の行の選び方は比べない）', () => {
  assert.equal(handRef({ op: 'text@1', ui: 'text', ref: { key: 'office.name' } }), 'office.name')
  assert.equal(handRef({ op: 'text@1', ui: 'text', ref: { key: 'family.members', path: [{ flag: 'isKeyPerson' }, 'phone'] } }), 'family.members[].phone')
  assert.equal(handRef({ op: 'option@1', ui: 'check', ref: { key: 'handbook.mental', path: ['has'] } }), 'handbook.mental.has')
  // 行の種類で選ぶ印（年金の種類など）は、行の欄まで書く
  assert.equal(handRef({ op: 'option@1', ui: 'check', ref: { key: 'pensions' }, is: { rowWhere: { kind: { eq: '障害年金' } } } }), 'pensions[].kind')
})

test('手の対応が条件や直し方で別の key も使っているときは、そのどれを答えても合っているとみなす', () => {
  const b = {
    op: 'option@1', ui: 'check', ref: { key: 'independence.physical', path: ['judgedBy'] },
    if: { any: [{ ref: { key: 'independence.physical', path: ['judgedBy'] }, is: { eq: 'ケアマネ' } }, { ref: { key: 'independence.dementia', path: ['judgedBy'] }, is: { eq: 'ケアマネ' } }] },
  }
  assert.deepEqual([...handRefs(b)].sort(), ['independence.dementia.judgedBy', 'independence.physical.judgedBy'])
})

test('比べ方: 近い欄どうしを組にして、見つけた割合・位置のずれ・対応の一致を数える', () => {
  const hand = {
    schemas: [
      { name: '氏名', type: 'text', position: { x: 30, y: 30 }, width: 40, height: 4 },
      { name: '男', type: 'text', position: { x: 90, y: 30 }, width: 3, height: 3 },
      { name: '住所', type: 'text', position: { x: 30, y: 40 }, width: 100, height: 4 },
    ],
    bindings: {
      氏名: { op: 'text@1', ui: 'text', ref: { key: 'person.name' } },
      男: { op: 'option@1', ui: 'circle', ref: { key: 'person.sex' }, is: { eq: '男' } },
      住所: { op: 'text@1', ui: 'text', ref: { key: 'person.address' } },
    },
  }
  const ai: DraftSlot[] = [
    { x: 30.2, y: 30.1, w: 39, h: 4, ui: 'text', ref: 'person.name', label: '氏名', confidence: 0.9 },
    { x: 90.5, y: 30, w: 3, h: 3, ui: 'circle', ref: 'person.sex', mark: { kind: 'eq', value: '女' }, label: '男', confidence: 0.8 },
    { x: 150, y: 200, w: 10, h: 4, ui: 'text', ref: null, label: 'ほかの欄', confidence: 0.3 },
  ]
  const r = compareDraft(ai, hand)
  assert.equal(r.hand, 3)
  assert.equal(r.ai, 3)
  assert.equal(r.found, 2, '住所は見つけていない')
  assert.equal(r.extra, 1, 'ほかの欄は手の版にない')
  assert.equal(r.refMatch, 2, '氏名と性別の key は合っている')
  assert.equal(r.optionMatch, 0, '丸の選択肢は「男」なのに「女」と答えた')
  assert.equal(r.optionTotal, 1)
  assert.equal(r.within.mm1, 2, 'どちらも左上が 1mm 以内')
  assert.equal(r.within.mm03, 1, '0.3mm 以内は氏名だけ')
  assert.deepEqual(r.missed, ['住所'])
})

test('AI が家族の行を番号で書いても（family.members[0].name）、行の欄として比べる', () => {
  const hand = {
    schemas: [{ name: '主介護者_氏名', type: 'text', position: { x: 30, y: 30 }, width: 40, height: 4 }],
    bindings: { 主介護者_氏名: { op: 'text@1', ui: 'text', ref: { key: 'family.members', path: [{ flag: 'isMainCaregiver' }, 'name'] } } },
  }
  const r = compareDraft([{ x: 30, y: 30, w: 40, h: 4, ui: 'text', ref: 'family.members[0].name', label: '主介護者氏名', confidence: 0.9 }], hand)
  assert.equal(r.refMatch, 1)
})

test('□・丸が表すもの: 手の対応の条件を、AI と同じ 6 つの形にそろえる', () => {
  const h = (x: Record<string, unknown>) => handMark({ op: 'option@1', ui: 'check', ref: { key: 'k' }, ...x })
  assert.deepEqual(h({ is: { eq: '男' } }), { kind: 'eq', value: '男' })
  assert.deepEqual(h({ is: { startsWith: '要支援' } }), { kind: 'eq', value: '要支援' })
  assert.deepEqual(h({ is: { rowWhere: { kind: { eq: '障害年金' } } } }), { kind: 'eq', value: '障害年金' })
  assert.deepEqual(h({ is: { eq: true } }), { kind: 'true' })
  assert.deepEqual(h({ is: { eq: false } }), { kind: 'false' })
  assert.deepEqual(h({ is: { not: { in: ['1割', '2割'] } } }), { kind: 'none' })
  assert.deepEqual(h({ is: { nonEmpty: true } }), { kind: 'nonEmpty' })
  assert.deepEqual(h({ if: { any: [{ ref: { key: 'k' }, is: { nonEmpty: true } }] } }), { kind: 'nonEmpty' })
  assert.deepEqual(h({ if: { all: [{ ref: { key: 'k' }, is: { empty: true } }] } }), { kind: 'empty' })
  assert.equal(h({}), null, '条件のない印は比べない')
})

test('□・丸の比べ方: 表すものの形と値が同じなら合っている（値は手の値で始まればよい）', () => {
  const hand = {
    schemas: [
      { name: '希望あり', type: 'text', position: { x: 10, y: 10 }, width: 3, height: 3 },
      { name: '見込める', type: 'text', position: { x: 20, y: 10 }, width: 3, height: 3 },
      { name: '不明', type: 'text', position: { x: 30, y: 10 }, width: 3, height: 3 },
    ],
    bindings: {
      希望あり: { op: 'option@1', ui: 'check', ref: { key: 'conf.want' }, is: { eq: true } },
      見込める: { op: 'option@1', ui: 'check', ref: { key: 'care' }, is: { startsWith: '見込める' } },
      不明: { op: 'option@1', ui: 'check', ref: { key: 'rate' }, is: { not: { in: ['1割'] } } },
    },
  }
  const mk = (x: number, ref: string, mark: DraftSlot['mark']): DraftSlot => ({ x, y: 10, w: 3, h: 3, ui: 'check', ref, mark, label: '', confidence: 1 })
  const r = compareDraft([mk(10, 'conf.want', { kind: 'true' }), mk(20, 'care', { kind: 'eq', value: '見込める（十分）' }), mk(30, 'rate', { kind: 'eq', value: '不明' })], hand)
  assert.equal(r.optionTotal, 3)
  assert.equal(r.optionMatch, 2, '不明は「どれでもない」なのに値として答えた')
})

test('予算: 記録した円の合計に見込みを足して上限を超えるなら止める', () => {
  const ledger = ['{"yen":10000}', '', '{"yen":19000.5}'].join('\n')
  assert.equal(spentYen(ledger), 29000.5)
  assert.doesNotThrow(() => checkBudget(29000.5, 999, 30000))
  assert.throws(() => checkBudget(29000.5, 1000, 30000), /予算/)
})

test('AI が行を印の名前で選んでも（family.members[isKeyPerson].name）、行の欄として比べる', () => {
  const hand = {
    schemas: [{ name: 'キーパーソン_氏名', type: 'text', position: { x: 30, y: 30 }, width: 40, height: 4 }],
    bindings: { キーパーソン_氏名: { op: 'text@1', ui: 'text', ref: { key: 'family.members', path: [{ flag: 'isKeyPerson' }, 'name'] } } },
  }
  const r = compareDraft([{ x: 30, y: 30, w: 40, h: 4, ui: 'text', ref: 'family.members[isKeyPerson].name', label: '', confidence: 1 }], hand)
  assert.equal(r.refMatch, 1)
})

test('手の対応が行を番号で選んでいるとき（path: [0, "name"]）も、行の欄として書く', () => {
  assert.equal(handRef({ op: 'text@1', ui: 'text', ref: { key: 'family.members', path: [0, 'name'] } }), 'family.members[].name')
})

test('表のマス: 罫線で四方を囲まれた四角を見つける。中の線が途切れた所は 1 つのマスにまとめる', () => {
  // 2 行 × 3 列の表。下の行は真ん中の縦線がなく、左 2 列が 1 つのマス
  const page = {
    width: 210, height: 297, words: [],
    hlines: [[10, 10, 70], [20, 10, 70], [30, 10, 70]] as [number, number, number][],
    vlines: [[10, 10, 30], [30, 10, 20], [50, 10, 30], [70, 10, 30]] as [number, number, number][],
  }
  const cells = findCells(page).map((c) => [c.x, c.y, c.w, c.h])
  assert.deepEqual(cells, [[10, 10, 20, 10], [30, 10, 20, 10], [50, 10, 20, 10], [10, 20, 40, 10], [50, 20, 20, 10]])
})

test('表のマス: □ のような小さい四角は入れない', () => {
  const page = {
    width: 210, height: 297, words: [],
    hlines: [[10, 10, 12], [12, 10, 12]] as [number, number, number][],
    vlines: [[10, 10, 12], [12, 10, 12]] as [number, number, number][],
  }
  assert.deepEqual(findCells(page), [])
})

test('マスの番号で答えた欄は、マスの内側に置き直す', () => {
  const cells = [{ id: 1, x: 10, y: 10, w: 20, h: 10 }]
  const [s] = placeInCells([{ x: 0, y: 0, w: 1, h: 1, ui: 'text', ref: null, label: '', confidence: 1, cell: 1 }], cells)
  assert.deepEqual([s.x, s.y, s.w, s.h], [10.8, 10.8, 18.4, 8.4])
  const [t] = placeInCells([{ x: 5, y: 5, w: 3, h: 3, ui: 'check', ref: null, label: '', confidence: 1 }], cells)
  assert.deepEqual([t.x, t.y], [5, 5], 'マスの番号がなければそのまま')
})

test('続きの答えは、すでに出した欄とほぼ同じ位置の欄を除いて足す', () => {
  const a: DraftSlot = { x: 10, y: 10, w: 20, h: 4, ui: 'text', ref: 'a', label: 'A', confidence: 1 }
  const dup: DraftSlot = { ...a, x: 10.5, y: 10.2 }
  const b: DraftSlot = { ...a, x: 50, label: 'B' }
  assert.deepEqual(addMissing([a], [dup, b]).map((s) => s.label), ['A', 'B'])
})

test('事業所だけの欄: 欄が使う local.* はすべて定義があり、定義は重ならず、使われない定義は捨てる', () => {
  const slot = (ref: string | null): DraftSlot => ({ x: 0, y: 0, w: 1, h: 1, ui: 'circle', ref, label: '', confidence: 1 })
  const r = mergeLocalFields(
    [slot('local.q1'), slot('local.q1'), slot('local.place'), slot('person.name'), slot('local.unknown'), slot(null)],
    [
      { key: 'local.q1', label: 'バスや電車で 1 人で外出していますか', type: 'enum', choices: ['0.はい', '1.いいえ'] },
      { key: 'local.place', label: '開催場所', type: 'text' },
      { key: 'local.place', label: '開催場所（重なり）', type: 'text' },
      { key: 'local.unused', label: '使わない', type: 'text' },
      { key: 'Bad Key', label: '形が違う', type: 'text' },
    ],
  )
  assert.deepEqual(r.fields.map((f) => f.key), ['local.q1', 'local.place'])
  assert.equal(r.fields[1].label, '開催場所', '重なったら先の定義')
  assert.deepEqual(r.problems, [
    'local.place の定義が 2 つある（先の定義を使う）',
    'Bad Key は local.<英字> の形でない',
    'local.unknown を使う欄があるが定義がない',
    '値の key も local.* もない欄が 1 つある',
  ])
})

test('見直しの答えを当てる: 番号の欄を直し、取り除き、漏れた欄を足す（番号は 1 から）', () => {
  const s = (label: string, x: number, ref = 'a'): DraftSlot => ({ x, y: 10, w: 5, h: 4, ui: 'text', ref, label, confidence: 1 })
  const have = [s('現状', 10, 'care.plan'), s('計画', 20, 'care.current'), s('見出し', 30)]
  const r = applyReview(have, {
    fixes: [{ id: 1, slot: s('現状', 10, 'care.current') }, { id: 2, slot: s('計画', 20, 'care.plan') }, { id: 9, slot: s('ない番号', 0) }],
    removes: [3],
    slots: [s('漏れ', 40), s('現状（重なり）', 10.5)],
  })
  assert.deepEqual(r.slots.map((x) => `${x.label}:${x.ref}`), ['現状:care.current', '計画:care.plan', '漏れ:a'])
  assert.deepEqual(r.changes, { fixed: 2, removed: 1, added: 1 })
})

test('事業所だけの欄: local. を付け忘れた定義と、それを使う欄には local. を補う', () => {
  const slot: DraftSlot = { x: 0, y: 0, w: 1, h: 1, ui: 'text', ref: 'tenureOther', label: '', confidence: 1 }
  const { slots, defs } = fixLocalPrefix([slot, { ...slot, ref: 'person.name' }], [{ key: 'tenureOther', label: '所有の形 その他', type: 'text' }], ['person.name'])
  assert.deepEqual(slots.map((x) => x.ref), ['local.tenureOther', 'person.name'])
  assert.equal(defs[0].key, 'local.tenureOther')
})

test('□ の一覧: 「□」などの文字と、線で描いた小さな正方形の両方を見つけ、重なりは 1 つにする', () => {
  const page = {
    width: 210, height: 297, words: [],
    chars: [
      { t: '□', x0: 10, y0: 10, x1: 13, y1: 13, ink: [10.2, 10.3, 12.8, 12.9] },
      { t: '有', x0: 13, y0: 10, x1: 16, y1: 13 },
      { t: '☐', x0: 40, y0: 10, x1: 43, y1: 13 },
    ],
    // 線で描いた 4mm の正方形（辺が二重線）と、文字の □ に重なる線の四角
    hlines: [[20, 60, 64], [20.1, 60, 64], [24, 60, 64], [10.3, 10.2, 12.8], [12.9, 10.2, 12.8]] as [number, number, number][],
    vlines: [[60, 20, 24], [64, 20, 24], [10.2, 10.3, 12.9], [12.8, 10.3, 12.9]] as [number, number, number][],
  }
  const boxes = findBoxes(page).map((b) => [b.id, b.x, b.y, b.w, b.h])
  assert.deepEqual(boxes, [[1, 10.2, 10.3, 2.6, 2.6], [2, 40, 10, 3, 3], [3, 60, 20, 4, 4]])
})

test('□ の一覧: 正方形でない四角や、大きすぎる四角は □ にしない', () => {
  const page = {
    width: 210, height: 297, words: [], chars: [],
    hlines: [[20, 60, 70], [24, 60, 70], [40, 60, 72], [52, 60, 72]] as [number, number, number][],
    vlines: [[60, 20, 24], [70, 20, 24], [60, 40, 52], [72, 40, 52]] as [number, number, number][],
  }
  assert.deepEqual(findBoxes(page), [])
})

test('□ の番号で答えた欄は □ の位置に置き、どの欄にも使われていない □ を数える', () => {
  const boxes = [{ id: 1, x: 10, y: 10, w: 3, h: 3 }, { id: 2, x: 20, y: 10, w: 3, h: 3 }]
  const [s] = placeInBoxes([{ x: 0, y: 0, w: 1, h: 1, ui: 'check', ref: 'a', label: '', confidence: 1, box: 1 }], boxes)
  assert.deepEqual([s.x, s.y, s.w, s.h], [10, 10, 3, 3])
  assert.deepEqual(unusedBoxes([s], boxes).map((b) => b.id), [2])
})

test('はい・いいえの key の □ に印がなければ「はい」とみなす。ほかの型は補わない', () => {
  const types = new Map([['conf.want', 'bool'], ['care.items[].current', 'bool'], ['sex', 'enum']])
  const s = (ref: string): DraftSlot => ({ x: 0, y: 0, w: 1, h: 1, ui: 'check', ref, label: '', confidence: 1 })
  const out = defaultMarks([s('conf.want'), s('care.items[item=a].current'), s('sex')], types)
  assert.deepEqual(out.map((x) => x.mark), [{ kind: 'true' }, { kind: 'true' }, undefined])
})

test('表のマス: 文字を線で描いた短い断片は、表の線の位置を決めるのに使わない。点線のように短い線が並ぶ罫線は使う', () => {
  // 2 列の表（x=10・30・50）。x=29.6 と 30.4 に、見出しの文字を線で描いた短い断片がある
  const table = {
    hlines: [[10, 10, 50], [20, 10, 50]] as [number, number, number][],
    vlines: [[10, 10, 20], [30, 10, 20], [50, 10, 20], [29.6, 2, 2.5], [30.4, 2, 2.6]] as [number, number, number][],
  }
  assert.deepEqual(findCells(table).map((c) => [c.x, c.y, c.w, c.h]), [[10, 10, 20, 10], [30, 10, 20, 10]])
  // 下の横線が 1mm の点線（1mm ごとに 0.5mm の線）
  const dotted = {
    hlines: [[10, 10, 50], ...Array.from({ length: 40 }, (_, k) => [20, 10 + k, 10.5 + k])] as [number, number, number][],
    vlines: [[10, 10, 20], [50, 10, 20]] as [number, number, number][],
  }
  assert.equal(findCells(dotted).length, 1)
})

test('行のある事業所だけの欄は、行ごとの欄にする（local.x[0] → local.x_1。定義は行ごとに作り、名前に何行目かを付ける）', () => {
  const s = (ref: string, label: string): DraftSlot => ({ x: 0, y: 0, w: 1, h: 1, ui: 'text', ref, label, confidence: 1 })
  const r = flattenLocalRows(
    [s('local.current[0]', '運動・移動 現在の状況'), s('local.current[1]', '日常生活 現在の状況'), s('local.attendee[2].name', '氏名 3'), s('local.memo[]', 'メモ'), s('person.name', '氏名'), s('local.place', '開催場所')],
    [{ key: 'local.current', label: '現在の状況', type: 'longtext' }, { key: 'local.attendee', label: '出席者', type: 'text' }, { key: 'local.place', label: '開催場所', type: 'text' }],
  )
  assert.deepEqual(r.slots.map((x) => x.ref), ['local.current_1', 'local.current_2', 'local.attendee_3_name', 'local.memo_1', 'person.name', 'local.place'])
  assert.deepEqual(r.defs.map((d) => [d.key, d.label, d.type]), [
    ['local.place', '開催場所', 'text'],
    ['local.current_1', '現在の状況（1 行目）', 'longtext'],
    ['local.current_2', '現在の状況（2 行目）', 'longtext'],
    ['local.attendee_3_name', '出席者（3 行目）の name', 'text'],
    ['local.memo_1', 'メモ（1 行目）', 'text'],
  ])
  assert.deepEqual(r.problems, ['local.memo[] は何行目か分からないので 1 行目にした', 'local.memo の定義がないので、欄のそばの文字を名前にした'])
})

test('事業所だけの欄: 中身が同じ定義の重なり（見直しの回で書き直して返したもの）は要確認にしない', () => {
  const s: DraftSlot = { x: 0, y: 0, w: 1, h: 1, ui: 'text', ref: 'local.place', label: '', confidence: 1 }
  const def = { key: 'local.place', label: '開催場所', type: 'text' as const }
  assert.deepEqual(mergeLocalFields([s], [def, { ...def }]), { fields: [def], problems: [] })
  assert.deepEqual(mergeLocalFields([s], [def, { ...def, type: 'longtext' }]).problems, ['local.place の定義が 2 つある（先の定義を使う）'])
})
