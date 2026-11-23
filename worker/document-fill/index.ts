// 書類を作るときに AI が書く（#195）の流れ 5〜7。DB には触らない（DB は ./job.ts）。
//   5. 書く: 書く先のページごとに 1 回頼む。欄ごとに keep（そのまま）／write（書き直す）／skip（書かない）
//   6. 確かめる: 型・選択肢・欄からのはみ出し。外れた欄だけ、外れた理由を添えて 1 回だけ頼み直す。それでも外れたら書かない
//   7. 最後の確かめ: 書いた値のうち元の書類に根拠のない部分を切らせる。切っただけでない答え・全部切った欄は書かない
// 1 つの呼び出しが失敗しても全体は止めない（その欄を書かない）。ログに中身は出さない。
import { fieldDict } from '../../core/dictionary.ts'
import { isCut, overflowKeys, type FillTarget } from '../../core/fill.ts'
import type { FormDef } from '../../core/form.ts'
import { prepareWriterValues } from '../job-values.ts'
import type { Usage } from '../types.ts'
import { candidateFields, mapLimit, settle, validateValue, warmThenMap, type Spec } from '../vertex/common.ts'
import type { Llm } from '../vertex/gemini.ts'
import { checkPrompt, checkSchema, fmtTarget, writePrompt, writeSchema, type Source } from './prompt.ts'

export interface FillInput {
  source: Source
  target: {
    kindName: string
    form: FormDef
    /** 書く先の書類の今の値（はみ出しの確かめに使う） */
    values: Record<string, unknown>
    /** AI に渡す欄（core/fill.ts の fillTargets） */
    targets: FillTarget[]
  }
  llm: Llm
  concurrency?: number
  /** 画面に出す段が進んだとき（write: 欄に書く・check: 書いた中身を確かめる） */
  onStep?: (step: 'write' | 'check') => Promise<void>
}

export interface FillResult {
  /** 書類に入れる値（applyBatch に渡す） */
  proposed: Record<string, { value: unknown }>
  /** 呼び出しの失敗があったか */
  partial: boolean
  steps: {
    pages: number
    targets: number
    /** 頼み直した欄の数 */
    retried: number
    /** 頼み直しても外れて書かなかった欄 */
    notWritten: string[]
    /** 最後の確かめで切った欄・書かなかった欄の数 */
    cut: number
    dropped: number
    failedCalls: number
  }
  usage: Usage
}

/** 答えの形の項目（properties）の数の上限（Gemini は大きすぎる形を断る）。超える分は呼び出しを分ける */
const MAX_PROPS = 150
const countProps = (x: unknown): number => {
  if (Array.isArray(x)) return x.reduce((n: number, y) => n + countProps(y), 0)
  if (!x || typeof x !== 'object') return 0
  let n = 0
  for (const [k, v] of Object.entries(x)) {
    if (k === 'properties' && v && typeof v === 'object') n += Object.keys(v).length
    n += countProps(v)
  }
  return n
}
function chunks(specs: Spec[]): Spec[][] {
  const out: Spec[][] = []
  let cur: Spec[] = []
  let n = 0
  for (const s of specs) {
    const k = countProps(writeSchema([s]))
    if (cur.length && n + k > MAX_PROPS) { out.push(cur); cur = []; n = 0 }
    cur.push(s)
    n += k
  }
  if (cur.length) out.push(cur)
  return out
}

type Answer = { action?: unknown, value?: unknown }
const fieldsOf = (r: unknown): Record<string, Answer> => {
  const f = (r as { fields?: unknown })?.fields
  return f && typeof f === 'object' && !Array.isArray(f) ? f as Record<string, Answer> : {}
}

export async function fillDocument(input: FillInput): Promise<FillResult> {
  const { source, target, llm } = input
  const limit = Math.max(1, input.concurrency ?? 4)
  const dict = fieldDict(target.form.localFields)
  const specOf = new Map(candidateFields(target.form).map((s) => [s.key, s]))
  const targets = target.targets.filter((t) => specOf.has(t.key))
  const byKey = new Map(targets.map((t) => [t.key, t]))
  const overflowing = overflowKeys(target.form, target.values)
  let failedCalls = 0

  /** 書いた値（確かめを通ったもの）と、使った元の書類の欄 */
  const written = new Map<string, unknown>()
  /** 外れた欄と理由 */
  const wrong = new Map<string, string>()

  /** 1 つの欄の答えを確かめる。通れば written、外れれば wrong に入れる */
  const judge = (key: string, a: Answer | undefined) => {
    const t = byKey.get(key)!
    const spec = specOf.get(key)!
    const mustRewrite = t.copied && overflowing.has(key)
    if (!a || a.action === 'skip' || a.action === 'keep') {
      if (mustRewrite) wrong.set(key, '今の値は欄からはみ出すので、書き直しが必要です')
      return
    }
    if (a.action !== 'write') { wrong.set(key, 'action が keep・write・skip のどれでもない'); return }
    const [clean, problems] = validateValue(spec, a.value)
    const { proposed } = prepareWriterValues(clean === null ? {} : { [key]: { value: clean } }, dict)
    if (problems.length || !(key in proposed)) { wrong.set(key, problems[0] ?? '値が空か、型に合わない'); return }
    const value = proposed[key].value
    if (overflowKeys(target.form, { ...target.values, [key]: value }).has(key)) {
      wrong.set(key, `欄からはみ出す。${t.chars ? `およそ ${t.chars} 字まで` : '短くする'}`)
      return
    }
    wrong.delete(key)
    written.set(key, value)
  }

  // 5. 書く（ページごと。答えの形が大きいときは分ける）
  await input.onStep?.('write')
  const pages = [...new Set(targets.map((t) => t.page))].sort((a, b) => (a || Infinity) - (b || Infinity))
  const units = pages.flatMap((page) => chunks(targets.filter((t) => t.page === page).map((t) => specOf.get(t.key)!)))
  const item = (s: Spec, reason?: string) => fmtTarget(byKey.get(s.key)!, s, source.kindName, byKey.get(s.key)!.copied && overflowing.has(s.key), reason)
  const results = await warmThenMap(units, limit, (specs) => settle(llm.ask(writePrompt(source, target.kindName, specs.map((s) => item(s)), false), writeSchema(specs), { step: '欄に書く', group: byKey.get(specs[0].key)!.page })))
  results.forEach((r, i) => {
    if (!r.ok) { failedCalls++; return }
    const fields = fieldsOf(r.value)
    for (const s of units[i]) judge(s.key, fields[s.key])
  })

  // 6. 外れた欄だけ、1 回だけ頼み直す
  const retryKeys = [...wrong.keys()]
  if (retryKeys.length) {
    const reasons = new Map(wrong)
    const retryUnits = chunks(retryKeys.map((k) => specOf.get(k)!))
    const retried = await mapLimit(retryUnits, limit, (specs) => settle(llm.ask(writePrompt(source, target.kindName, specs.map((s) => item(s, reasons.get(s.key))), true), writeSchema(specs), { step: '頼み直し' })))
    retried.forEach((r, i) => {
      if (!r.ok) { failedCalls++; return }
      const fields = fieldsOf(r.value)
      for (const s of retryUnits[i]) judge(s.key, fields[s.key])
    })
  }
  const notWritten = retryKeys.filter((k) => !written.has(k))

  // 7. 最後の確かめ。根拠のない部分を切った値を返させ、切っただけかを確かめる
  const proposed: Record<string, { value: unknown }> = {}
  let cut = 0, dropped = 0, partial = failedCalls > 0
  if (written.size) {
    await input.onStep?.('check')
    const specs = [...written.keys()].map((k) => specOf.get(k)!)
    const items = specs.map((s) => `### ${s.key}（${s.label}）\n- 値: ${JSON.stringify(written.get(s.key))}`)
    const r = await settle(llm.ask(checkPrompt(source, target.kindName, items), checkSchema(specs), { step: '最後の確かめ' }))
    if (!r.ok) {
      failedCalls++
      partial = true
      dropped = written.size
    } else {
      const fields = fieldsOf(r.value)
      for (const s of specs) {
        const before = written.get(s.key)
        const [after] = validateValue(s, fields[s.key]?.value ?? null)
        if (after === null || !isCut(after, before)) { dropped++; continue }
        if (JSON.stringify(after) !== JSON.stringify(before)) cut++
        proposed[s.key] = { value: after }
      }
    }
  }
  return {
    proposed, partial,
    steps: { pages: pages.length, targets: targets.length, retried: retryKeys.length, notWritten, cut, dropped, failedCalls },
    usage: llm.usage(),
  }
}
