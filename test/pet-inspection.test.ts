// 点検の画面の決まり（src/components/petInspection.ts）。決定版: https://claude.ai/artifact/La1RqwX2TgoBN8eyRtfyPi
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catMessage, fmtWhen, historyRows, itemNote, menuStatus, monthGroups, radar } from '../src/components/inspection/petInspection.ts'
import type { InspectionSummary, InspectionView } from '../db/inspections.ts'

const summary = (id: string, createdAt: string, missingCount: number, status: InspectionSummary['status'] = 'succeeded'): InspectionSummary => ({
  id, status, createdAt, createdBy: '加藤', verdict: status === 'succeeded' ? (missingCount ? '要確認' : '適合') : null, missingCount, total: 32,
})
const view = (over: Partial<InspectionView> = {}): InspectionView => ({
  ...summary('a', '2026-11-20T05:05:00Z', 6), checkSet: 'mhlw-careplan@2026-03', categories: [], items: [], latest: true, changed: false, ...over,
})

test('日時は日本の時刻で「11/20 14:05」', () => {
  assert.equal(fmtWhen('2026-11-20T05:05:00Z'), '11/20 14:05')
  assert.equal(fmtWhen('2026-05-21T06:40:00Z'), '5/21 15:40')
  assert.equal(fmtWhen('2026-11-19T15:30:00Z'), '11/20 00:30', '日付は日本の日')
})

test('メニューの「点検する」の小さい字: まだ／点検しています…／要確認 N件／適合', () => {
  assert.deepEqual(menuStatus(undefined), null, '読み込む前は出さない')
  assert.deepEqual(menuStatus([]), { text: '（まだ点検していません）', tone: 'none' })
  assert.deepEqual(menuStatus([summary('b', '2026-11-20T06:00:00Z', 0, 'processing'), summary('a', '2026-11-20T05:05:00Z', 6)]), { text: '（点検しています…）', tone: 'none' })
  assert.deepEqual(menuStatus([summary('a', '2026-11-20T05:05:00Z', 6)]), { text: '（要確認 6件）', tone: 'ng' })
  assert.deepEqual(menuStatus([summary('a', '2026-11-20T05:05:00Z', 0)]), { text: '（適合）', tone: 'ok' })
  assert.deepEqual(menuStatus([summary('c', '2026-11-20T06:00:00Z', 0, 'failed'), summary('a', '2026-11-20T05:05:00Z', 6)]), { text: '（要確認 6件）', tone: 'ng' }, '失敗した点検は飛ばす')
})

test('猫の言葉: 結果・適合・用紙が変わった・前の回を見ている', () => {
  assert.deepEqual(catMessage(view()), { before: '点検の結果は', pill: '要確認', after: 'です。32 項目のうち 6 項目で、情報が足りません。' })
  assert.deepEqual(catMessage(view({ missingCount: 0, verdict: '適合' })), { before: '点検の結果は', pill: '適合', after: 'です。確認が必要なところはありません。' })
  assert.deepEqual(catMessage(view({ changed: true })), { before: '前の点検（11/20 14:05）のあとに、用紙が変わっています。もう一度点検しますか？' })
  assert.deepEqual(catMessage(view({ latest: false, missingCount: 8 })), { before: 'このときの結果は', pill: '要確認', after: 'でした。32 項目のうち 8 項目で、情報が足りませんでした。' })
  assert.deepEqual(catMessage(view({ latest: false, missingCount: 0, verdict: '適合' })), { before: 'このときの結果は', pill: '適合', after: 'でした。確認が必要なところはありませんでした。' })
})

test('項目の下の言葉: 足りない情報。用紙に欄がなければ「・用紙に欄なし」。判定できなかった項目', () => {
  const base = { id: '10', name: '一日に摂取すべき水分量', category: '生活の全体像の把握' }
  assert.equal(itemNote({ ...base, level: '1', missing: '量（mL など）が書かれていない', fieldKey: null, documentId: null }), '量（mL など）が書かれていない・用紙に欄なし')
  assert.equal(itemNote({ ...base, level: '1', missing: '起床・就寝が書かれていない', fieldKey: 'dailySchedule', documentId: 'd' }), '起床・就寝が書かれていない')
  assert.equal(itemNote({ ...base, level: '2', missing: null, fieldKey: null, documentId: null }), null)
  assert.equal(itemNote({ ...base, level: null, missing: null, fieldKey: null, documentId: null }), '判定できませんでした')
})

test('これまでの点検: 終わった点検だけ、新しい順。前回との差（減・増・同じ）。いま表示の印', () => {
  const list = [
    summary('d', '2026-11-25T01:10:00Z', 0),
    summary('x', '2026-11-24T01:10:00Z', 0, 'failed'),
    summary('c', '2026-11-20T05:05:00Z', 6),
    summary('b', '2026-11-18T01:30:00Z', 8),
    summary('a', '2026-11-12T07:20:00Z', 8),
  ]
  const rows = historyRows(list, 'c')
  assert.deepEqual(rows.map((r) => [r.id, r.when, r.label, r.tone, r.diff, r.current]), [
    ['d', '11/25 10:10', '適合', 'ok', '前回より 6 減', false],
    ['c', '11/20 14:05', '要確認 6', 'ng', '前回より 2 減', true],
    ['b', '11/18 10:30', '要確認 8', 'ng', '前回と同じ', false],
    ['a', '11/12 16:20', '要確認 8', 'ng', null, false],
  ])
  assert.equal(historyRows([summary('b', '2026-11-18T01:30:00Z', 9), summary('a', '2026-11-12T07:20:00Z', 6)], 'b')[0].diff, '前回より 3 増')
})

test('すべて見る: 月ごと（日本の月）', () => {
  const rows = historyRows([
    summary('c', '2026-11-20T05:05:00Z', 6), summary('b', '2026-05-21T06:40:00Z', 0), summary('a', '2025-11-30T15:30:00Z', 2),
  ], 'c')
  assert.deepEqual(monthGroups(rows).map((g) => [g.month, g.rows.map((r) => r.id)]), [['2026年11月', ['c']], ['2026年5月', ['b']], ['2025年12月', ['a']]])
})

test('レーダー: 5 つの観点の点・値・色。決定版の形（中心 170,140、半径 72）', () => {
  const r = radar([
    { category: '生活の全体像の把握', satisfied: 8, total: 13 },
    { category: '疾病・心身状態の把握', satisfied: 9, total: 10 },
    { category: '主訴・意思の把握・尊重', satisfied: 3, total: 3 },
    { category: '課題の分析', satisfied: 4, total: 4 },
    { category: '家族の状況の把握と支援', satisfied: 2, total: 2 },
  ])
  assert.deepEqual(r.axes.map((a) => [a.x, a.y]), [[170, 68], [238.48, 117.75], [212.32, 198.25], [127.68, 198.25], [101.52, 117.75]])
  assert.deepEqual(r.points.map((p) => [p.x, p.y, p.ng]), [[170, 95.69, true], [231.63, 119.98, true], [212.32, 198.25, false], [127.68, 198.25, false], [101.52, 117.75, false]])
  assert.equal(r.rings.length, 4)
  assert.deepEqual(r.labels[0], { lines: ['生活の全体像の把握'], value: '8 / 13', ng: true, x: 170, y: 40, anchor: 'middle' })
  assert.deepEqual(r.labels[1], { lines: ['疾病・心身', '状態の把握'], value: '9 / 10', ng: true, x: 250, y: 102, anchor: 'start' })
  assert.deepEqual(r.labels[3], { lines: ['課題の分析'], value: '4 / 4', ng: false, x: 120, y: 216, anchor: 'end' })
  assert.match(r.label, /生活の全体像の把握 8\/13、疾病・心身状態の把握 9\/10/)
})
