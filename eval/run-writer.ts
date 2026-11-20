// 録音から欄を書く処理だけを、演習シナリオ（eval/scenario/原本.json、公開・架空）で動かし、bench の提出の形で書き出す。
// 使い方: node eval/run-writer.ts --out <フォルダ> [--pipeline two-layer|summary] [--dry]
//   --pipeline: two-layer（既定。今の 2 層改）か summary（作り替えた流れ。要約 → 欄を選ぶ → 書く → 全体のまとめ → 最後のチェック。docs/再設計/17）
//   --dry: Gemini を呼ばない（答えを空にして、指示文の量だけ数える。費用の見積もりと流れの確かめ用）
// summary では、1 回の面談（visit）を録音 1 本として扱い、場面の全部の記録を文字起こしの発言にする（worker/fake.ts の FakeStt と同じ）。
// 要約は <out>/<時点>/summaries.json にも書き出す（bench が要約の漏れを数える）。
// 本物の Gemini を呼ぶときは GOOGLE_CLOUD_PROJECT が要る（費用がかかる）。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { seedFormDef } from '../forms/admin/files.ts'
import type { Topic } from '../core/topics.ts'
import { candidateFields } from '../worker/vertex/common.ts'
import { geminiFactory, type Llm } from '../worker/vertex/gemini.ts'
import { summarizer } from '../worker/vertex/summarizer.ts'
import { topicWriter } from '../worker/vertex/topic-writer.ts'
import { sheetWriter } from '../worker/vertex/writer.ts'
import { ZERO_USAGE, type Person, type SummaryLine, type Usage, type Utterance, type Visit, type WriterResult } from '../worker/types.ts'

const { values: args } = parseArgs({ options: { out: { type: 'string' }, dry: { type: 'boolean', default: false }, pipeline: { type: 'string', default: 'two-layer' } } })
if (!args.out || !['two-layer', 'summary'].includes(args.pipeline!)) {
  console.error('使い方: node eval/run-writer.ts --out <フォルダ> [--pipeline two-layer|summary] [--dry]')
  process.exit(2)
}
const out = args.out
const pipeline = args.pipeline as 'two-layer' | 'summary'

/** アセスメントのまとめる項目（form_kinds.topics）。DB を立てずに使うため、移行の SQL のうち、いちばん新しく一覧を入れたものから読む */
function assessmentTopics(): Topic[] {
  const dir = new URL('../db/migrations/', import.meta.url)
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().reverse()) {
    const sql = readFileSync(new URL(name, dir), 'utf8')
    const at = sql.indexOf('UPDATE form_kinds SET topics = $json$')
    if (at >= 0 && sql.slice(at).includes("WHERE key = 'assessment'")) return JSON.parse(sql.slice(at).split('$json$')[1]) as Topic[]
    const row = sql.indexOf("('assessment', 'アセスメント'")
    if (row >= 0) return JSON.parse(sql.slice(row).split('$json$')[3]) as Topic[]
  }
  throw new Error('アセスメントのまとめる項目が移行にありません')
}

const genpon = JSON.parse(readFileSync(new URL('./scenario/原本.json', import.meta.url), 'utf8')) as {
  people: Record<string, { role: Person['role'], relation?: string }>
  visits: Visit[]
}
const people: Person[] = Object.entries(genpon.people).map(([label, p]) => ({ label, role: p.role, relation: p.relation ?? null }))
// 演習シナリオはアセスメントを書く（全体のアセスメントの様式の版）
const form = seedFormDef('assessment')
const byKey = new Map(candidateFields(form).map((s) => [s.key, s]))

let dryChars = 0
const dryCalls: Record<string, { calls: number, chars: number }> = {}
const dryFactory = (): Llm => ({
  ask: async (prompt, schema, meta) => {
    const n = String(prompt).length
    dryChars += n
    const d = (dryCalls[meta.step] ??= { calls: 0, chars: 0 })
    d.calls++
    d.chars += n
    // 流れを最後まで通すため、欄を選ぶ段だけは、どのページでも候補の全部を選んだことにする（呼ぶ回数と指示文の量の見積もりの上限）
    if (meta.step === '欄を選ぶ') {
      const s = schema as { properties: { fields: { items: { properties: { key: { enum: string[] }, topics: { items: { enum: string[] } } } } } } }
      const topics = s.properties.fields.items.properties.topics.items.enum
      return { fields: s.properties.fields.items.properties.key.enum.map((key) => ({ key, topics: [topics[0]] })) }
    }
    if (meta.step === '要約') {
      const s = schema as { properties: { summaries: { properties: Record<string, unknown> } } }
      // 項目の半分ほどが話に出たことにする
      return { summaries: Object.fromEntries(Object.keys(s.properties.summaries.properties).filter((_, i) => i % 2 === 0).map((k) => [k, '（見積もり用の要約）'.repeat(20)])) }
    }
    return {}
  },
  usage: () => ({ ...ZERO_USAGE }),
})
const newLlm = args.dry ? dryFactory : geminiFactory(process.env)
const concurrency = Number(process.env.GEMINI_CONCURRENCY) || 4
const writer = sheetWriter(newLlm, { concurrency })
const topics = assessmentTopics()
const summarize = summarizer(newLlm)
const topicWrite = topicWriter(newLlm, { concurrency })
const summaryLines: SummaryLine[] = []

/** 1 回の面談を録音 1 本として、要約から書く。要約は足していく（アセスメント） */
async function bySummary(i: number, current: Record<string, unknown>): Promise<WriterResult & { summaries: SummaryLine[] }> {
  const visit = genpon.visits[i]
  const utterances: Utterance[] = visit.scenes.flatMap((s) => s.entries).map((e, j) => ({
    id: e.id ?? `${visit.id}-${j + 1}`, startMs: null, endMs: null, speaker: e.speaker ?? '記録', person: e.speaker ?? '記録', text: e.text,
  }))
  const s = await summarize.summarize({ kindName: 'アセスメント', topics: topics.filter((t) => t.by === 'ai'), utterances, people })
  for (const l of summaryLines) l.isNew = false
  for (const [topic, text] of Object.entries(s.texts)) summaryLines.push({ id: `${visit.id}-${topic}`, topic, seq: i + 1, date: visit.date, text, isNew: true })
  const r = await topicWrite.write({ kindName: 'アセスメント', topics, summaries: summaryLines.map((l) => ({ ...l })), showNew: i > 0, current, form })
  const usage = { ...r.usage }
  for (const k of ['calls', 'promptTokens', 'cachedTokens', 'outputTokens', 'thinkingTokens', 'yen'] as const) usage[k] += s.usage[k]
  return { ...r, usage, summaries: summaryLines.filter((l) => l.seq === i + 1) }
}

const write = (path: string, data: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 1) + '\n')
}

const total: Usage = { ...ZERO_USAGE }
const perVisit: Record<string, unknown> = {}
let current: Record<string, unknown> = {}

for (const [i, visit] of genpon.visits.entries()) {
  const t = visit.id
  const t0 = Date.now()
  const r = pipeline === 'summary'
    ? await bySummary(i, current)
    : await writer.write({ visits: genpon.visits.slice(0, i + 1), newVisitId: t, current, people, first: i === 0, form })
  // 2 回目以降は、直した欄だけが返る。シートは、前の値に重ねたもの（bench は時点ごとのシート全体を採点する）
  const prev = i === 0 ? {} : JSON.parse(readFileSync(join(out, genpon.visits[i - 1].id, 'sheet.json'), 'utf8')).fields as Record<string, { value: unknown, cite?: string[] }>
  const merged: Record<string, { value: unknown, cite: unknown }> = {}
  for (const [k, v] of Object.entries(prev)) merged[k] = { value: v.value, cite: v.cite ?? [] }
  for (const [k, v] of Object.entries(r.values)) merged[k] = { value: v.value, cite: v.cite ?? [] }

  // 2 層の根拠は、欄ごとに「根拠の発言」を 1 件の事実の形にして、bench の根拠の確かめに使う（common.py の pseudo_facts）
  const facts: unknown[] = []
  const known = genpon.visits.slice(0, i + 1).flatMap((v) => v.scenes.flatMap((sc) => sc.entries.map((e) => e.id)))
  const fields: Record<string, unknown> = {}
  Object.keys(merged).sort().forEach((k, j) => {
    const rec = merged[k]
    if (rec.value === null || rec.value === undefined) return
    const fid = `e${t.slice(1)}-${String(j + 1).padStart(3, '0')}`
    // 要約から書く流れの根拠は要約の行までなので、その時点までの記録の全部を根拠にする（bench の根拠違いは 2 層改と比べられない）
    const from = pipeline === 'summary' ? known : (Array.isArray(rec.cite) ? rec.cite : [])
    facts.push({ id: fid, text: `${byKey.get(k)?.label ?? k}の根拠`, who: null, kind: 'said', from })
    fields[k] = { value: rec.value, by: 'ai', facts: [fid], cite: rec.cite }
  })
  write(join(out, t, 'sheet.json'), { fields, unplaced: [] })
  if ('summaries' in r) write(join(out, t, 'summaries.json'), { summaries: summaryLines.filter((l) => l.seq <= i + 1).map(({ id, topic, seq, text }) => ({ id, topic, seq, text })) })
  write(join(out, t, 'facts.json'), { facts })
  write(join(out, t, 'questions.json'), { questions: [] })

  current = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v.value]))
  perVisit[t] = { seconds: (Date.now() - t0) / 1000, fields: Object.keys(fields).length, returned: Object.keys(r.values).length, failed: r.failed, usage: r.usage }
  total.calls += r.usage.calls
  total.promptTokens += r.usage.promptTokens
  total.cachedTokens += r.usage.cachedTokens
  total.outputTokens += r.usage.outputTokens
  total.thinkingTokens += r.usage.thinkingTokens
  total.yen += r.usage.yen
  console.log(`${t}: 欄 ${Object.keys(fields).length}、呼び出し ${r.usage.calls}、入力 ${r.usage.promptTokens}（キャッシュ ${r.usage.cachedTokens}）、思考 ${r.usage.thinkingTokens}、失敗 [${r.failed.join(', ')}]、${Math.round(r.usage.yen)} 円`)
}

write(join(out, 'usage.json'), { pipeline, model: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash', dry: args.dry, ...(args.dry ? { dryPromptChars: dryChars, dryCalls } : {}), total, visits: perVisit })
console.log(`合計: ${total.calls} 回、${Math.round(total.yen)} 円${args.dry ? `（dry: 指示文 ${dryChars} 字）` : ''}`)
