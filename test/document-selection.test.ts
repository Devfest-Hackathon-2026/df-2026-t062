import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCanvas } from '@napi-rs/canvas'
import { readDocument } from '../worker/document-input/read.ts'
import { auditSelections } from '../worker/document-input/selection.ts'

test('モデルが確実と返しても、薄い印・無印・単一選択の複数印・回答方法不明は原文に残して保留する', async () => {
  const data = createCanvas(10, 10).toBuffer('image/png')
  const selections = [
    { mode: 'single', options: [{ text: 'あり', mark: 'faint' }, { text: 'なし', mark: 'none' }] },
    { mode: 'single', options: [{ text: 'あり', mark: 'none' }, { text: 'なし', mark: 'none' }] },
    { mode: 'single', options: [{ text: 'あり', mark: 'clear' }, { text: 'なし', mark: 'clear' }] },
    { mode: 'unknown', options: [{ text: 'あり', mark: 'clear' }] },
    { mode: 'multiple', options: [{ text: '右', mark: 'unclear' }, { text: '左', mark: 'clear' }] },
  ]
  for (const selection of selections) {
    const result = await readDocument(data, { id: 'marks', mime: 'image/png', ask: async () => ({
      entries: [{ text: '確認項目', recordedOn: null, region: null, uncertain: false, selection }], issues: [],
    }) })
    assert.equal(result.evidence[0].uncertain, true)
    assert.equal(result.issues.length, 1)
    assert.match(result.evidence[0].text, /選択欄の原文/)
    assert.match(result.visit.scenes[0].entries[0].text, /要確認/)
  }
})
test('複数回答可の明確な複数印は保留せず、明記された選択状態をそのまま保持する', async () => {
  const result = await readDocument(createCanvas(10, 10).toBuffer('image/png'), { id: 'multiple', mime: 'image/png', ask: async () => ({
    entries: [{ text: '希望する連絡方法（複数回答可）', recordedOn: null, region: null, uncertain: false,
      selection: { mode: 'multiple', options: [{ text: '電話', mark: 'clear' }, { text: '郵便', mark: 'clear' }, { text: 'メール', mark: 'none' }] } }], issues: [],
  }) })
  assert.equal(result.evidence[0].uncertain, false)
  assert.deepEqual(result.issues, [])
  assert.match(result.evidence[0].text, /メール［印なし］/)
})
test('照合には原本の回答・印の状態を渡さず、不一致・欠落・重複した行は保留する', async () => {
  const rows = ['一致', '薄い印', '回答欠落', '回答重複'].map((label) => ({ text: '原本の回答は照合に送らない', uncertain: false,
    selection: { label, mode: 'single' as const, options: [{ text: 'はい', mark: 'clear' as const }, { text: 'いいえ', mark: 'none' as const }] } }))
  const issues = await auditSelections(rows, [{ png: new Uint8Array() }], async (prompt) => {
    const encoded = typeof prompt === 'string' ? prompt : prompt.flatMap((part) => 'text' in part ? [part.text] : []).join('\n')
    assert.equal(encoded.includes('原本の回答は照合に送らない'), false)
    assert.equal(encoded.includes('"mark":'), false)
    return { rows: [{ id: '0', marks: ['clear', 'none'] }, { id: '1', marks: ['none', 'none'] },
      { id: '3', marks: ['clear', 'none'] }, { id: '3', marks: ['clear', 'none'] }] }
  }, 1)
  assert.deepEqual([...issues.keys()], [1, 2, 3])
})
test('照合後の保留をページキャッシュに保存し、再試行で判定を失わず二重課金しない', async () => {
  const data = createCanvas(1600, 1200).toBuffer('image/png')
  let saved: unknown
  let calls = 0
  const first = await readDocument(data, { id: 'cached-audit', mime: 'image/png', ask: async (_prompt, _schema, meta) => {
    calls++
    return meta.step === '書類の読取' ? { entries: [{ text: '移動：見守り', recordedOn: null, region: null, uncertain: false,
      selection: { label: '移動', mode: 'single', options: [{ text: '見守り', mark: 'clear' }, { text: '介助', mark: 'none' }] } }], issues: [] }
      : { rows: [{ id: '0', marks: ['none', 'none'] }] }
  }, onPage: async (_page, result) => { saved = result } })
  const second = await readDocument(data, { id: 'cached-audit', mime: 'image/png', pages: { 1: saved as never }, ask: async () => { throw new Error('再読取しない') } })
  assert.equal(calls, 2)
  assert.equal(first.evidence[0].uncertain, true)
  assert.deepEqual(second, first)
})
test('要確認が100件を超えてもキャッシュを再読でき、全行の保留を保持する', async () => {
  const data = createCanvas(1600, 1200).toBuffer('image/png')
  let saved: unknown
  const first = await readDocument(data, { id: 'many', mime: 'image/png', ask: async (_p, _s, meta) => meta.step === '選択欄の照合' ? { rows: [] } : {
    entries: Array.from({ length: 101 }, (_, index) => ({ text: `架空項目${index}`, recordedOn: null, region: null, uncertain: false,
      selection: { label: `架空項目${index}`, mode: 'single', options: [{ text: 'あり', mark: 'clear' }] } })), issues: [],
  }, onPage: async (_page, result) => { saved = result } })
  const second = await readDocument(data, { id: 'many', mime: 'image/png', pages: { 1: saved as never }, ask: async () => { throw new Error('呼ばない') } })
  assert.equal(first.evidence.filter((entry) => entry.uncertain).length, 101)
  assert.deepEqual(second, first)
})
