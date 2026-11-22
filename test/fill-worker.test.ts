// 書類を作るときに AI が書く（#195）の流れ 5〜7: ページごとに頼む → 確かめる → 外れた欄だけ 1 回頼み直す → 最後の確かめ。AI は偽物。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fillTargets } from '../core/fill.ts'
import { seedFormDef } from '../forms/admin/files.ts'
import { fillDocument } from '../worker/document-fill/index.ts'
import type { AskMeta, Llm, Prompt } from '../worker/vertex/gemini.ts'
import { ZERO_USAGE } from '../worker/types.ts'

const admission = seedFormDef('admission')
const LONG = 'あ'.repeat(200)

type Answers = { write?: Record<string, unknown>, retry?: Record<string, unknown>, check?: Record<string, unknown> }
function fake(answers: Answers, opts: { failCheck?: boolean } = {}) {
  const calls: { step: string, prompt: Prompt, keys: string[] }[] = []
  const llm: Llm = {
    ask: async (prompt, schema, meta: AskMeta) => {
      const keys = Object.keys((schema as any).properties.fields.properties)
      calls.push({ step: meta.step, prompt, keys })
      if (meta.step === '最後の確かめ') {
        if (opts.failCheck) throw new Error('boom')
        return { fields: Object.fromEntries(keys.map((k) => [k, { value: k in (answers.check ?? {}) ? answers.check![k] : null }])) }
      }
      const src = meta.step === '頼み直し' ? answers.retry ?? {} : answers.write ?? {}
      return { fields: Object.fromEntries(keys.map((k) => [k, src[k] ?? { action: 'skip', value: null, from: [] }])) }
    },
    usage: () => ZERO_USAGE,
  }
  return { llm, calls }
}

const run = (values: Record<string, unknown>, copied: string[], llm: Llm) => {
  const current = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, by: 'ai' }]))
  return fillDocument({
    source: { kindName: 'アセスメント', text: '生活の経過: 長い文', images: [{ text: '1 ページ' }, { png: new Uint8Array([1]) }] },
    target: { kindName: '入院時情報提供書', form: admission, values, targets: fillTargets(admission, current, new Set(copied)) },
    llm,
  })
}

test('書く: AI が書き直した文字の欄と、空の欄に書いた値を返す。書かないと答えた欄は返さない', async () => {
  const { llm } = fake({
    write: {
      'person.lifeHistory': { action: 'write', value: '農家に生まれる。', from: ['生活の経過'] },
      'cert.careLevel': { action: 'write', value: '要介護2', from: ['要介護度'] },
      'housing.notes': { action: 'skip', value: null, from: [] },
    },
    check: { 'person.lifeHistory': '農家に生まれる。', 'cert.careLevel': '要介護2' },
  })
  const r = await run({}, [], llm)
  assert.deepEqual(r.proposed, { 'person.lifeHistory': { value: '農家に生まれる。' }, 'cert.careLevel': { value: '要介護2' } })
})

test('書く: 写した日付・選択肢の欄は聞かず、AI が答えても書き直さない', async () => {
  const { llm, calls } = fake({
    write: { 'cert.careLevel': { action: 'write', value: '要介護3', from: [] } },
    check: { 'cert.careLevel': '要介護3' },
  })
  const r = await run({ 'cert.careLevel': '要介護2', 'person.birthDate': '1940-01-02' }, ['cert.careLevel', 'person.birthDate'], llm)
  assert.ok(!calls.some((c) => c.keys.includes('cert.careLevel') || c.keys.includes('person.birthDate')))
  assert.deepEqual(r.proposed, {})
})

test('頼み直し: はみ出した欄・選択肢にない値は 1 回だけ頼み直し、直れば書く', async () => {
  const { llm, calls } = fake({
    write: {
      'person.lifeHistory': { action: 'write', value: LONG, from: [] },
      'cert.careLevel': { action: 'write', value: '要介護9', from: [] },
    },
    retry: {
      'person.lifeHistory': { action: 'write', value: '短い生活歴。', from: [] },
      'cert.careLevel': { action: 'write', value: '要介護1', from: [] },
    },
    check: { 'person.lifeHistory': '短い生活歴。', 'cert.careLevel': '要介護1' },
  })
  const r = await run({}, [], llm)
  assert.equal(calls.filter((c) => c.step === '頼み直し').length, 1)
  assert.deepEqual(calls.find((c) => c.step === '頼み直し')!.keys.sort(), ['cert.careLevel', 'person.lifeHistory'])
  assert.deepEqual(r.proposed, { 'person.lifeHistory': { value: '短い生活歴。' }, 'cert.careLevel': { value: '要介護1' } })
})

test('頼み直し: 写した値がはみ出すのに「そのまま」と答えたら頼み直す。2 回目も外れたら書かない（写した値が残る）', async () => {
  const { llm, calls } = fake({
    write: { 'person.lifeHistory': { action: 'keep', value: null, from: [] } },
    retry: { 'person.lifeHistory': { action: 'write', value: LONG + 'い', from: [] } },
  })
  const r = await run({ 'person.lifeHistory': LONG }, ['person.lifeHistory'], llm)
  assert.equal(calls.filter((c) => c.step === '頼み直し').length, 1)
  assert.deepEqual(r.proposed, {})
  assert.deepEqual(r.steps.notWritten, ['person.lifeHistory'])
})

test('最後の確かめ: 切ったあとの値を書く。語を足した答えと、全部切った欄は書かない', async () => {
  const { llm } = fake({
    write: {
      'person.lifeHistory': { action: 'write', value: '農家に生まれる。料理が得意。', from: [] },
      'housing.notes': { action: 'write', value: '段差が多い。', from: [] },
      'intention.person': { action: 'write', value: '家に帰りたい。', from: [] },
    },
    check: { 'person.lifeHistory': '農家に生まれる。', 'housing.notes': '段差が多い。手すりあり。', 'intention.person': null },
  })
  const r = await run({}, [], llm)
  assert.deepEqual(r.proposed, { 'person.lifeHistory': { value: '農家に生まれる。' } })
})

test('最後の確かめ: 確かめの呼び出しが失敗したら、何も書かない（根拠を確かめられない値は入れない）', async () => {
  const { llm } = fake({ write: { 'person.lifeHistory': { action: 'write', value: '農家に生まれる。', from: [] } } }, { failCheck: true })
  const r = await run({}, [], llm)
  assert.deepEqual(r.proposed, {})
  assert.equal(r.partial, true)
})

test('材料の並び: どの頼みも、元の書類の材料（文と画像）を同じ並びで先頭に置く（キャッシュに当てるため）', async () => {
  const { llm, calls } = fake({
    write: { 'person.lifeHistory': { action: 'write', value: LONG, from: [] } },
    retry: { 'person.lifeHistory': { action: 'write', value: '短い。', from: [] } },
    check: { 'person.lifeHistory': '短い。' },
  })
  await run({}, [], llm)
  assert.deepEqual(new Set(calls.map((c) => c.step)), new Set(['欄に書く', '頼み直し', '最後の確かめ']))
  const head = (p: Prompt) => JSON.stringify((p as unknown[]).slice(0, 3))
  for (const c of calls) assert.equal(head(c.prompt), head(calls[0].prompt))
})
