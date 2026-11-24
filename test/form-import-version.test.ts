// 様式の取り込み（#99）: ページごとの下書き（AI の答え）を、版の形（schemas・bindings・pages・local_fields）と要確認の一覧にする。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkBindings, renderSlot, editSlot, type Binding } from '../core/binding.ts'
import type { DraftSlot, LocalField } from '../worker/form-import/draft.ts'
import type { PageDraft } from '../worker/form-import/convert.ts'
import { buildVersion } from '../worker/form-import/version.ts'
import { checkDraftVersion } from '../worker/form-import/check.ts'

const slot = (label: string, ui: DraftSlot['ui'], ref: string | null, more: Partial<DraftSlot> = {}): DraftSlot =>
  ({ x: 10, y: 10, w: 20, h: 4, ui, ref, label, confidence: 1, ...more })
const page = (no: number, slots: DraftSlot[], localFields: LocalField[] = [], problems: string[] = []): PageDraft =>
  ({ page: no, width: 210, height: 297, slots, localFields, problems, cells: [], boxes: [], rounds: [], outside: 0 })

test('文字の欄: pdfme の文字の欄と text@1 にする。印字欄の名前は「p<ページ>_<そばの文字>」で、重なれば番号を付ける', () => {
  const v = buildVersion([page(1, [slot('氏名', 'text', 'person.name'), slot('氏名', 'text', 'person.nameKana'), slot('生活歴', 'area', 'person.lifeHistory', { h: 20 })])])
  assert.deepEqual(Object.keys(v.bindings), ['p1_氏名', 'p1_氏名_2', 'p1_生活歴'])
  assert.deepEqual(v.bindings.p1_氏名, { op: 'text@1', ui: 'text', ref: { key: 'person.name' } })
  assert.deepEqual(v.bindings.p1_生活歴, { op: 'text@1', ui: 'area', ref: { key: 'person.lifeHistory' } })
  const [name, , life] = v.schemas[0]
  assert.equal(name.type, 'text')
  assert.deepEqual([name.position, name.width, name.height], [{ x: 10, y: 10 }, 20, 4])
  assert.equal(life.verticalAlignment, 'top', '複数行は上から')
  assert.deepEqual(v.pages, [{ no: 1, pdfIndex: 0, title: '1 ページ', width: 210, height: 297 }])
  assert.deepEqual(v.review, [])
})

test('日付を年・月・日に分けた欄は date@1、元号の丸は era@1', () => {
  const v = buildVersion([page(1, [
    slot('生年月日 年', 'text', 'person.birthDate', { part: 'y' }),
    slot('生年月日 月', 'text', 'person.birthDate', { part: 'm' }),
    slot('昭', 'circle', 'person.birthDate', { part: 'era', mark: { kind: 'eq', value: '昭' } }),
  ])])
  assert.deepEqual(v.bindings['p1_生年月日年'], { op: 'date@1', ui: 'text', ref: { key: 'person.birthDate' }, part: 'y' })
  assert.deepEqual(v.bindings['p1_昭'], { op: 'era@1', ui: 'circle', ref: { key: 'person.birthDate' }, era: 'S' })
  assert.equal(v.schemas[0][2].type, 'circleMark')
})

test('元号の丸で「表すもの」が省かれていたら、そばの印字（明・大・昭…）から元号を読む', () => {
  const v = buildVersion([page(1, [slot('明', 'circle', 'person.birthDate', { part: 'era' }), slot('令和', 'circle', 'person.birthDate', { part: 'era' })])])
  assert.deepEqual([v.bindings['p1_明'], v.bindings['p1_令和']].map((b) => (b as Extract<Binding, { op: 'era@1' }>).era), ['M', 'R'])
  assert.deepEqual(v.review, [])
})

test('□・丸の「表すもの」を、手で作った版と同じ条件と付け外しの動きにする', () => {
  const v = buildVersion([page(1, [
    slot('男', 'circle', 'person.sex', { mark: { kind: 'eq', value: '男' } }),
    slot('要支援', 'check', 'cert.careLevel', { mark: { kind: 'eq', value: '要支援' } }),
    slot('身体', 'circle', 'disabilityCertificateSummary', { mark: { kind: 'eq', value: '身体' } }),
    slot('国民年金', 'check', 'pensions[].kind', { mark: { kind: 'eq', value: '国民年金（老齢基礎）' } }),
    slot('年金 その他', 'check', 'pensions[].kind', { mark: { kind: 'none' } }),
    slot('不明', 'check', 'insurance.careCopayRate', { mark: { kind: 'none' } }),
    slot('生活保護', 'check', 'welfare.publicAssistance', { mark: { kind: 'true' } }),
    slot('同封 その他', 'check', 'admission.enclosedOther', { mark: { kind: 'nonEmpty' } }),
  ])])
  const b = v.bindings
  assert.deepEqual(b['p1_男'], { op: 'option@1', ui: 'circle', ref: { key: 'person.sex' }, is: { eq: '男' } })
  assert.deepEqual(b['p1_要支援'], { op: 'option@1', ui: 'check', ref: { key: 'cert.careLevel' }, is: { startsWith: '要支援' }, edit: { on: { refuse: '「要支援」に当たる値を書いてください' }, off: { set: [{ value: null }] } } })
  assert.deepEqual(b['p1_身体'], { op: 'option@1', ui: 'circle', ref: { key: 'disabilityCertificateSummary' }, is: { has: '身体' } })
  assert.deepEqual(b['p1_国民年金'], { op: 'option@1', ui: 'check', ref: { key: 'pensions' }, is: { rowWhere: { kind: { eq: '国民年金（老齢基礎）' } } } })
  assert.deepEqual((b['p1_年金その他'] as Extract<Binding, { op: 'option@1' }>).is, { rowWhere: { kind: { notIn: ['国民年金（老齢基礎）', '厚生年金（老齢）', '共済年金（老齢）', '障害年金', '遺族年金', '寡婦年金', '恩給', 'その他'] } } })
  assert.deepEqual(b['p1_不明'], { op: 'option@1', ui: 'check', ref: { key: 'insurance.careCopayRate' }, is: { not: { in: ['1割', '2割', '3割'] } }, edit: { on: { set: [{ value: null }] }, off: { refuse: '「不明」以外の値を書いてください' } } })
  assert.deepEqual(b['p1_生活保護'], { op: 'option@1', ui: 'check', ref: { key: 'welfare.publicAssistance' }, is: { eq: true } })
  assert.deepEqual(b['p1_同封その他'], { op: 'option@1', ui: 'check', ref: { key: 'admission.enclosedOther' }, is: { nonEmpty: true }, edit: { on: { refuse: '「同封 その他」の中身を書くと ✓ が付きます' }, off: { refuse: '「同封 その他」の中身を消すと ✓ が外れます' } } })
  assert.deepEqual(checkBindings(b), [], '共通の仕組みの確かめを通る')
  // 実際に描けて、付け外しできる
  assert.equal(renderSlot(b['p1_男'], { 'person.sex': '男' }), 'true')
  assert.deepEqual(editSlot(b, {}, 'p1_生活保護', '✓'), { changes: [{ key: 'welfare.publicAssistance', value: true }] })
  assert.deepEqual(v.review, [])
})

test('行の指し方: 印の名前・番号・行の中身で選ぶ。何行目か分からなければ 1 行目にして要確認', () => {
  const v = buildVersion([page(2, [
    slot('キーパーソン 氏名', 'text', 'family.members[isKeyPerson].name'),
    slot('家族 2 氏名', 'text', 'family.members[1].name'),
    slot('年金 内容', 'text', 'pensions[kind=遺族年金].detail'),
    slot('家族 氏名', 'text', 'family.members[].name'),
  ])])
  assert.deepEqual(v.bindings['p2_キーパーソン氏名'].ref, { key: 'family.members', path: [{ flag: 'isKeyPerson' }, 'name'] })
  assert.deepEqual(v.bindings['p2_家族2氏名'].ref, { key: 'family.members', path: [1, 'name'] })
  assert.deepEqual(v.bindings['p2_年金内容'].ref, { key: 'pensions', path: [{ match: { kind: '遺族年金' } }, 'detail'] })
  assert.deepEqual(v.bindings['p2_家族氏名'].ref, { key: 'family.members', path: [0, 'name'] })
  assert.deepEqual(v.review, [{ slot: 'p2_家族氏名', reason: 'どの行の欄か分からないので、1 行目にした（family.members[].name）' }])
  assert.deepEqual(checkBindings(v.bindings), [])
})

test('事業所だけの欄: 定義をまとめて local_fields にする。印の意味が分からない欄・ない key の欄は、事業所だけの欄にして要確認', () => {
  const v = buildVersion([
    page(1, [
      slot('開催場所', 'text', 'local.meetingPlace'),
      slot('問 1 はい', 'circle', 'local.q1', { mark: { kind: 'eq', value: 'はい' } }),
      slot('謎の □', 'check', 'person.sex'),
      slot('存在しない', 'text', 'nothing.here'),
    ], [{ key: 'local.meetingPlace', label: '開催場所', type: 'text' }, { key: 'local.q1', label: '問 1', type: 'enum', choices: ['はい', 'いいえ'] }], ['local.x の定義が 2 つある（先の定義を使う）']),
    page(2, [slot('開催場所 2', 'text', 'local.meetingPlace')], [{ key: 'local.meetingPlace', label: '開催場所', type: 'longtext' }]),
  ])
  assert.deepEqual(v.localFields.map((f) => [f.key, f.type]), [['local.meetingPlace', 'text'], ['local.q1', 'enum'], ['local.p1_3', 'bool'], ['local.p1_4', 'text']])
  assert.deepEqual(v.bindings['p1_問1はい'], { op: 'option@1', ui: 'circle', ref: { key: 'local.q1' }, is: { eq: 'はい' } })
  assert.deepEqual(v.bindings['p1_謎の□'], { op: 'option@1', ui: 'check', ref: { key: 'local.p1_3' }, is: { eq: true } })
  assert.deepEqual(v.bindings['p1_存在しない'], { op: 'text@1', ui: 'text', ref: { key: 'local.p1_4' } })
  assert.deepEqual(v.review, [
    { slot: '', reason: '1 ページ: local.x の定義が 2 つある（先の定義を使う）' },
    { slot: 'p1_謎の□', reason: '印が何を表すか分からないので、事業所だけの「はい・いいえ」の欄にした（person.sex）' },
    { slot: 'p1_存在しない', reason: '値の一覧にない key なので、事業所だけの欄にした（nothing.here）' },
    { slot: '', reason: 'local.meetingPlace の定義がページで違う（先の定義を使う）' },
  ])
})

// #147: 点線で区切った時間割の行（ケアプラン第 3 表など）。一覧の行を、曜日と時刻の範囲で選ぶ
test('一覧の行を条件（範囲を含む）で選ぶ欄は、条件に合う行をすべて改行でつなぐ join@1 にする。1 桁の時は 2 桁にそろえる', () => {
  const v = buildVersion([page(1, [
    slot('月 9:00', 'text', 'plan.weekly[day=月,start=9:00〜10:00].service'),
    slot('火 22:00', 'text', 'plan.weekly[day=火,start=22:00~23:00].service'),
  ])])
  assert.deepEqual(v.bindings['p1_月9:00'], {
    op: 'join@1', ui: 'text', ref: { key: 'plan.weekly' },
    where: { day: { eq: '月' }, start: { between: ['09:00', '10:00'] } }, show: 'service', sep: '\n',
  })
  assert.deepEqual((v.bindings['p1_火22:00'] as Extract<Binding, { op: 'join@1' }>).where.start, { between: ['22:00', '23:00'] })
  assert.deepEqual(v.review, [])
  const values = { 'plan.weekly': [
    { day: '月', start: '09:30', end: '10:30', service: '入浴介助' },
    { day: '月', start: '09:00', end: '09:45', service: '服薬確認' },
    { day: '月', start: '10:00', end: '11:00', service: '通所介護' },
    { day: '火', start: '09:30', end: '10:30', service: '訪問看護' },
  ] }
  assert.equal(renderSlot(v.bindings['p1_月9:00'], values), '入浴介助\n服薬確認', '始まりが 9 時台の月曜の予定だけ。10:00 ちょうどは次の行')
  assert.equal(renderSlot(v.bindings['p1_火22:00'], values), '')
})

test('条件で行を選ぶ欄: 一覧にない項目の名前は、値の一覧にない key として事業所だけの欄にする', () => {
  const v = buildVersion([page(1, [slot('月 9:00', 'text', 'plan.weekly[weekday=月,start=09:00〜10:00].service')])])
  assert.equal(v.bindings['p1_月9:00'].ref.key, 'local.p1_1')
  assert.equal(v.review.length, 1)
})

test('等しいだけの条件を 2 つ書いた欄は、その両方に合う行（1 行）を読む', () => {
  const v = buildVersion([page(1, [slot('月 9:00', 'text', 'plan.weekly[day=月,start=09:00].service')])])
  assert.deepEqual(v.bindings['p1_月9:00'], { op: 'text@1', ui: 'text', ref: { key: 'plan.weekly', path: [{ match: { day: '月', start: '09:00' } }, 'service'] } })
})

// #128: 図欄（家族構成図・家屋見取図・身体図）。手で作った版（forms/seed/assessment）と同じ、image の印字欄と diagram@1 にする
test('図の枠（ui: diagram）は、pdfme の image の欄と diagram@1 にし、版の確かめを通る', () => {
  const v = buildVersion([page(2, [slot('家族構成図', 'diagram', 'family.genogram', { w: 75, h: 56 })])])
  assert.deepEqual(v.bindings['p2_家族構成図'], { op: 'diagram@1', ui: 'diagram', ref: { key: 'family.genogram' } })
  const [s] = v.schemas[0]
  assert.deepEqual([s.type, s.content, s.position, s.width, s.height], ['image', '', { x: 10, y: 10 }, 75, 56])
  assert.deepEqual(v.review, [])
  assert.deepEqual(checkDraftVersion({ ...v, pages: undefined }), [])
})

test('図の key を文字の欄（text・area）で答えても、図の欄にする', () => {
  const v = buildVersion([page(3, [slot('見取図', 'area', 'housing.floorPlan'), slot('障害等の部位', 'text', 'health.bodyMap')])])
  assert.deepEqual(Object.values(v.bindings).map((b) => [b.op, b.ui, b.ref.key]), [['diagram@1', 'diagram', 'housing.floorPlan'], ['diagram@1', 'diagram', 'health.bodyMap']])
  assert.deepEqual(v.schemas[0].map((s) => s.type), ['image', 'image'])
  assert.deepEqual(checkDraftVersion({ ...v, pages: undefined }), [])
})

test('図の枠に図でない key・ない key を答えたら、複数行の文字の欄にして要確認', () => {
  const v = buildVersion([page(1, [slot('生活歴', 'diagram', 'person.lifeHistory'), slot('地図', 'diagram', 'local.map')], [{ key: 'local.map', label: '地図', type: 'text' }])])
  assert.deepEqual(v.bindings['p1_生活歴'], { op: 'text@1', ui: 'area', ref: { key: 'person.lifeHistory' } })
  assert.deepEqual(v.bindings['p1_地図'], { op: 'text@1', ui: 'area', ref: { key: 'local.map' } })
  assert.deepEqual(v.schemas[0].map((s) => s.type), ['text', 'text'])
  assert.deepEqual(v.review, [
    { slot: 'p1_生活歴', reason: '図の欄ではない key なので、文字の欄にした（person.lifeHistory）' },
    { slot: 'p1_地図', reason: '図の欄ではない key なので、文字の欄にした（local.map）' },
  ])
  assert.deepEqual(checkDraftVersion({ ...v, pages: undefined }), [])
})
