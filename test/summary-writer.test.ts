// 録音からの書き込み（作り替え、#114）の AI を使う段。Gemini は偽物（段ごとに決めた答えを返す）。
// docs/再設計/17_録音からの書き込み.md の「テスト」の、要約・欄を選ぶ・書く・最後のチェック。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toFormDef } from '../core/form.ts'
import { topicsFingerprint, topicsFor, type Topic } from '../core/topics.ts'
import { ZERO_USAGE, type Person, type SummaryLine, type Utterance } from '../worker/types.ts'
import type { AskMeta, Llm } from '../worker/vertex/gemini.ts'
import { summarizer } from '../worker/vertex/summarizer.ts'
import { topicWriter } from '../worker/vertex/topic-writer.ts'

interface Call { step: string, group: AskMeta['group'], prompt: string, schema: any }

/** 段（meta.step）と group ごとに答えを返す偽の Gemini。呼ばれた順に calls に残す */
function script(answer: (c: Call) => unknown) {
  const calls: Call[] = []
  const newLlm = (): Llm => ({
    ask: async (prompt, schema, meta) => {
      const c: Call = { step: meta.step, group: meta.group, prompt: String(prompt), schema }
      calls.push(c)
      return answer(c)
    },
    usage: () => ({ ...ZERO_USAGE, calls: calls.length }),
  })
  return { calls, newLlm }
}

const slot = (name: string) => ({ name, type: 'text' as const, position: { x: 10, y: 10 }, width: 50, height: 8 })
const page = (no: number, title: string) => ({ no, pdfIndex: no - 1, title, width: 210, height: 297 })
const text = (key: string) => ({ op: 'text@1', ui: 'text', ref: { key } })

/** 3 ページの様式。3 ページ目は、事業所の設定と、出どころが書類だけの欄しかない（録音から書ける欄がない） */
const FORM = toFormDef({
  id: 'v-test', kind: 'test', name: '面談の記録', version: 1, contentSha: 'x',
  pages: [page(1, '表紙'), page(2, '暮らし'), page(3, '事業所')],
  schemas: [
    [slot('住所'), slot('受付方法')],
    [slot('生活歴'), slot('本人の思い'), slot('家族の思い'), slot('既往歴'), slot('まとめ')],
    [slot('事業所名'), slot('負担割合')],
  ],
  bindings: {
    住所: text('person.address'), 受付方法: text('intake.method'),
    生活歴: text('person.lifeHistory'), 本人の思い: text('complaint.person'), 家族の思い: text('complaint.family'), 既往歴: text('health.history'), まとめ: text('summary.overall'),
    事業所名: text('office.name'), 負担割合: text('insurance.careCopayRate'),
  } as never,
})

const TOPICS: Topic[] = [
  { id: 'basic', name: '基本情報', guide: '住所や受付の方法', by: 'ai', last: false },
  { id: 'history', name: 'これまでの生活', guide: '', by: 'ai', last: false },
  { id: 'wishes', name: '主訴・意向', guide: '本人と家族の思いを分けて', by: 'ai', last: false },
  { id: 'health', name: '健康状態', guide: '水分量は数字のまま残す', by: 'ai', last: false },
  { id: 'overall', name: '全体のまとめ', guide: '', by: 'ai', last: true },
  { id: 'date', name: 'その日の日付', guide: '', by: 'machine', last: false, keys: { first: 'assessment.initialDate', later: 'assessment.updateDate' } },
]

const line = (id: string, topic: string, seq: number, text: string, isNew = false): SummaryLine =>
  ({ id, topic, seq, date: seq === 1 ? '2026-11-10' : '2026-11-24', text, isNew })

/** 足していく種類の 2 回目（1 回目の要約と、今回足した要約） */
const SUMMARIES: SummaryLine[] = [
  line('u-b1', 'basic', 1, '自宅は見本市 1-1。訪問で受けた。'),
  line('u-w1', 'wishes', 1, '本人は「できるだけ自分でやりたい」と話す。'),
  line('u-h2', 'health', 2, '11 月に脳梗塞で入院した。', true),
  line('u-w2', 'wishes', 2, '娘は「夜が心配」と話す。', true),
]

const PEOPLE: Person[] = [{ label: '本人', role: '本人' }, { label: '長女', role: '家族', relation: '娘' }]
const UTTS: Utterance[] = [
  { id: 'r1-0001', startMs: 0, endMs: 1000, speaker: 'speaker_1', person: '本人', text: '家は見本市の 1-1 です' },
  { id: 'r1-0002', startMs: 1000, endMs: 2000, speaker: 'speaker_2', person: '長女', text: '夜がいちばん心配で' },
]

/** ふつうの答え: 1 ページ目は住所、2 ページ目は思い・既往歴・まとめを選ぶ。候補にない欄や、要約のない項目も混ぜる */
function answers(over: Partial<Record<string, (c: Call) => unknown>> = {}) {
  return (c: Call): unknown => {
    const hit = over[`${c.step}:${c.group}`] ?? over[c.step]
    if (hit) return hit(c)
    if (c.step === '欄を選ぶ' && c.group === 1) {
      return { fields: [
        { key: 'person.address', topics: ['basic'] },
        { key: 'office.name', topics: ['basic'] },            // 事業所の設定（候補にない）
        { key: 'complaint.person', topics: ['wishes'] },      // ほかのページの欄
        { key: 'ghost.key', topics: ['basic'] },              // 辞書にない
      ] }
    }
    if (c.step === '欄を選ぶ' && c.group === 2) {
      return { fields: [
        { key: 'complaint.person', topics: ['wishes'] },
        { key: 'health.history', topics: ['health', 'wishes', 'ghost'] },
        { key: 'person.lifeHistory', topics: ['history'] },  // 要約のない項目だけ
        { key: 'summary.overall', topics: ['overall'] },
      ] }
    }
    if (c.step === '書く' && c.group === 'basic') return { 'person.address': { value: '見本市 1-1', from: ['basic-1'] }, 'office.name': { value: '勝手な事業所', from: [] } }
    if (c.step === '書く' && c.group === 'wishes') return { 'complaint.person': { value: 'できるだけ自分でやりたい。', from: ['wishes-1'] } }
    if (c.step === '書く' && c.group === 'health') return { 'health.history': { value: '11 月に脳梗塞で入院。', from: ['health-2', 'nothing-9'] } }
    if (c.step === '全体のまとめ') return { 'summary.overall': { value: '自分でやりたい思いを支える。', from: ['wishes-1'] } }
    if (c.step === '最後のチェック') return { cuts: [] }
    throw new Error(`想定していない呼び出し: ${c.step} ${String(c.group)}`)
  }
}

const write = (newLlm: () => Llm, over: { summaries?: SummaryLine[], showNew?: boolean, current?: Record<string, unknown> } = {}) =>
  topicWriter(newLlm, { concurrency: 2 }).write({
    kindName: 'アセスメント', topics: TOPICS, summaries: over.summaries ?? SUMMARIES, showNew: over.showNew ?? true, current: over.current ?? {}, form: FORM,
  })

// ---------- まとめる項目 ----------

test('まとめる項目: 事業所の書き足しは全体の項目の説明のあとに足し、足した項目は最後に書く項目の前に置く', () => {
  assert.deepEqual(topicsFor(TOPICS, null), TOPICS, '事業所が直していなければ全体の一覧のまま')
  const merged = topicsFor(TOPICS, {
    added: [{ id: 'o1', name: 'ペット', guide: 'ペットの有無と世話をする人' }, { id: 'health', name: '乗っ取り', guide: '' }],
    notes: { health: '1 日の水分量も聞く', gone: '消えた項目への書き足し' },
  })
  assert.deepEqual(merged.map((t) => t.id), ['basic', 'history', 'wishes', 'health', 'o1', 'overall', 'date'], '全体の項目と同じ id の足しは使わない')
  assert.equal(merged.find((t) => t.id === 'health')!.guide, '水分量は数字のまま残す 1 日の水分量も聞く')
  assert.equal(merged.find((t) => t.id === 'health')!.name, '健康状態', '全体の項目の名前は変えられない')
  assert.deepEqual(merged.find((t) => t.id === 'o1'), { id: 'o1', name: 'ペット', guide: 'ペットの有無と世話をする人', by: 'ai', last: false })
  assert.notEqual(topicsFingerprint(merged), topicsFingerprint(TOPICS), '指紋で、直す前と後を見分ける')
  assert.equal(topicsFingerprint(topicsFor(TOPICS, { added: [], notes: {} })), topicsFingerprint(TOPICS))
})

// ---------- 要約 ----------

test('要約: 新しい録音を 1 回だけ全部読み、AI の項目ごとに要約する。話に出なかった項目は返さない', async () => {
  const { calls, newLlm } = script(() => ({ summaries: { basic: '家は見本市 1-1。', wishes: '長女は「夜がいちばん心配」と話す。', health: null, history: '  ', overall: null, date: '2026-11-10', ghost: '知らない項目' } }))
  const r = await summarizer(newLlm).summarize({ kindName: 'アセスメント', topics: TOPICS, utterances: UTTS, people: PEOPLE })
  assert.equal(calls.length, 1, '文字起こしの全部を読むのは要約の 1 回だけ')
  assert.equal(calls[0].step, '要約')
  for (const u of UTTS) assert.ok(calls[0].prompt.includes(u.text), '新しい録音の全部を渡す')
  assert.ok(calls[0].prompt.includes('住所や受付の方法') && calls[0].prompt.includes('主訴・意向'), '項目の名前と説明を渡す')
  assert.ok(!calls[0].prompt.includes('その日の日付'), '機械の項目は要約しない')
  assert.deepEqual(Object.keys(calls[0].schema.properties.summaries.properties), ['basic', 'history', 'wishes', 'health', 'overall'])
  assert.deepEqual(r.texts, { basic: '家は見本市 1-1。', wishes: '長女は「夜がいちばん心配」と話す。' })
})

// ---------- 欄を選ぶ ----------

test('欄を選ぶ: 候補は版が読む書いてよい欄だけ。候補のないページは呼ばない。候補にない欄を答えても書かない', async () => {
  const { calls, newLlm } = script(answers())
  const r = await write(newLlm)
  const selects = calls.filter((c) => c.step === '欄を選ぶ')
  assert.deepEqual(selects.map((c) => c.group), [1, 2], '3 ページ目（事業所の設定と、書類だけが出どころの欄）は呼ばない')
  const enumOf = (c: Call) => [...c.schema.properties.fields.items.properties.key.enum].sort()
  assert.deepEqual(enumOf(selects[0]), ['intake.method', 'person.address'])
  assert.deepEqual(enumOf(selects[1]), ['complaint.family', 'complaint.person', 'health.history', 'person.lifeHistory', 'summary.overall'])
  assert.deepEqual(Object.keys(r.values).sort(), ['complaint.person', 'health.history', 'person.address', 'summary.overall'])
  assert.equal(r.values['office.name'], undefined, '候補にない欄は書かない')
  assert.equal(r.values['person.lifeHistory'], undefined, '読む項目に要約がなければ書かない')
  assert.ok(selects[0].prompt.includes('住所や受付の方法'), '欄を選ぶ AI には項目の説明を渡す')
  assert.deepEqual(r.failed, [])
})

test('欄を選ぶ: 足していく種類の 2 回目からは、今回足した分の印と、そのページの欄の今の値を渡す', async () => {
  const lineOf = (prompt: string, ref: string) => prompt.split('\n').find((l) => l.includes(`[${ref}]`)) ?? ''
  const later = script(answers())
  await write(later.newLlm, { showNew: true, current: { 'complaint.person': '前に書いた思い。', 'office.name': '見本事業所' } })
  const p2 = later.calls.find((c) => c.step === '欄を選ぶ' && c.group === 2)!.prompt
  assert.ok(lineOf(p2, 'health-2').includes('今回'), '今回足した要約に印')
  assert.ok(!lineOf(p2, 'wishes-1').includes('今回'), '前の回の要約には印を付けない')
  assert.ok(p2.includes('前に書いた思い。'), 'そのページの欄の今の値')

  const first = script(answers())
  await write(first.newLlm, { showNew: false, current: { 'complaint.person': '前に書いた思い。' } })
  const q2 = first.calls.find((c) => c.step === '欄を選ぶ' && c.group === 2)!.prompt
  assert.ok(!lineOf(q2, 'health-2').includes('今回'), '1 回目・単体の種類は印を付けない')
  assert.ok(!q2.includes('前に書いた思い。'), '1 回目・単体の種類は今の値を見せない')
})

// ---------- 書く・全体のまとめ ----------

test('書く: 項目ごとに 1 回呼び、挙げた項目の要約を全部渡す。全体のまとめは最後に呼ばれ、書いた値と全部の要約を受け取る', async () => {
  const { calls, newLlm } = script(answers())
  await write(newLlm)
  const writes = calls.filter((c) => c.step === '書く')
  assert.deepEqual(writes.map((c) => c.group).sort(), ['basic', 'health', 'wishes'], '欄を選んだ項目ごとに 1 回（最初に挙げた項目のところで書く）')
  const health = writes.find((c) => c.group === 'health')!.prompt
  assert.ok(health.includes('11 月に脳梗塞') && health.includes('夜が心配') && health.includes('できるだけ自分でやりたい'), '挙げた項目（健康状態・主訴）の要約を全部')
  assert.ok(!writes.find((c) => c.group === 'basic')!.prompt.includes('脳梗塞'), '挙げていない項目の要約は渡さない')
  assert.deepEqual(Object.keys(writes.find((c) => c.group === 'health')!.schema.properties), ['health.history'])

  const finalAt = calls.findIndex((c) => c.step === '全体のまとめ')
  assert.ok(finalAt > Math.max(...writes.map((w) => calls.indexOf(w))), '全体のまとめは、ほかの項目を書いたあと')
  const final = calls[finalAt]
  assert.ok(final.prompt.includes('見本市 1-1') && final.prompt.includes('11 月に脳梗塞で入院。'), '書いた値を受け取る')
  assert.ok(final.prompt.includes('自宅は見本市 1-1。訪問で受けた。') && final.prompt.includes('娘は「夜が心配」と話す。'), '全部の項目の要約')
  assert.deepEqual(Object.keys(final.schema.properties), ['summary.overall'])
  const overallCheck = calls.findIndex((c) => c.step === '最後のチェック' && c.group === 'overall')
  assert.ok(overallCheck > finalAt, '全体のまとめも、書いたあとでチェックする')
})

test('根拠は要約の行まで: cite は、挙げた要約の行の id（知らない行は捨てる）', async () => {
  const { newLlm } = script(answers())
  const r = await write(newLlm)
  assert.deepEqual(r.values['person.address'].cite, { kind: 'summary', ids: ['u-b1'] })
  assert.deepEqual(r.values['health.history'].cite, { kind: 'summary', ids: ['u-h2'] })
  assert.deepEqual(r.values['summary.overall'].cite, { kind: 'summary', ids: ['u-w1'] })
})

// ---------- 最後のチェック ----------

test('最後のチェック: 切った部分は入らない。全部切られた欄は書かない（前の値が残る）。項目の説明は渡さない', async () => {
  const { calls, newLlm } = script(answers({
    '書く:wishes': () => ({
      'complaint.person': { value: 'できるだけ自分でやりたい。録音によると、娘は夜が心配。', from: ['wishes-1'] },
      'complaint.family': { value: '夜が心配。', from: ['wishes-2'] },
    }),
    '欄を選ぶ:2': () => ({ fields: [{ key: 'complaint.person', topics: ['wishes'] }, { key: 'complaint.family', topics: ['wishes'] }] }),
    '最後のチェック:wishes': () => ({ cuts: [{ id: 'complaint.person#1', reason: 'unneeded' }, { id: 'complaint.family#0', reason: 'no_source' }, { id: 'ghost#0', reason: 'unneeded' }] }),
  }))
  const r = await write(newLlm, { current: { 'complaint.family': '前の値' } })
  assert.equal(r.values['complaint.person'].value, 'できるだけ自分でやりたい。')
  assert.equal(r.values['complaint.family'], undefined, '全部切られた欄は書かない（applyBatch が前の値を残す）')
  const check = calls.find((c) => c.step === '最後のチェック' && c.group === 'wishes')!
  assert.deepEqual([...check.schema.properties.cuts.items.properties.id.enum].sort(), ['complaint.family#0', 'complaint.person#0', 'complaint.person#1'])
  assert.ok(check.prompt.includes('娘は「夜が心配」と話す。'), '書いたときと同じ要約を渡す')
  for (const c of calls.filter((x) => x.step === '最後のチェック')) {
    for (const t of TOPICS) if (t.guide) assert.ok(!c.prompt.includes(t.guide), `最後のチェックに項目の説明（${t.name}）は渡さない`)
  }
})

// ---------- 失敗・何もないとき ----------

test('一部の呼び出しが失敗しても全体は止めず、失敗した項目の欄を、書けなかった欄として返す', async () => {
  const { newLlm } = script(answers({ '書く:health': () => { throw new Error('boom') } }))
  const r = await write(newLlm)
  assert.deepEqual(r.failed, ['write:health'])
  assert.ok(r.incompleteFields.includes('health.history'))
  assert.equal(r.values['health.history'], undefined)
  assert.equal(r.values['person.address'].value, '見本市 1-1', 'ほかの項目は書く')
})

test('要約が 1 つもなければ（話に何も出なければ）AI を呼ばない', async () => {
  const { calls, newLlm } = script(answers())
  const r = await write(newLlm, { summaries: [] })
  assert.equal(calls.length, 0)
  assert.deepEqual(r.values, {})
})
