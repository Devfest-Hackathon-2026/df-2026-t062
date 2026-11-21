// AI 点検を演習シナリオの正解シートで流し、正解（eval/inspect/gold.json。Claude の叩き台）と比べる。
// 使い方: node eval/run-inspect.ts --out <フォルダ> [--dry]
//   --dry: Gemini を呼ばない（指示文の字数を数えて、費用を多めに見積もる。1 字 = 1 トークンとして数える）
// 本物の Gemini を呼ぶときは GOOGLE_CLOUD_PROJECT が要る（費用がかかる。流す前に見積もりを出して OK をもらう）。
// 流すのは、正解シート 1 回と、欄を消す・足す写し（gold.json の ablations）ごとに 1 回。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { checkSet, type Level } from '../core/checks/index.ts'
import { toFormDef } from '../core/form.ts'
import { readSeed } from '../forms/admin/files.ts'
import { inspect, type Finding } from '../worker/inspect/index.ts'
import { ZERO_USAGE, type Usage } from '../worker/types.ts'
import { geminiFactory, type Llm } from '../worker/vertex/gemini.ts'
import { applyAblation, scoreAblation, scoreLevels, type Gold } from './inspect/score.ts'

const { values: args } = parseArgs({ options: { out: { type: 'string' }, dry: { type: 'boolean', default: false } } })
if (!args.out) {
  console.error('使い方: node eval/run-inspect.ts --out <フォルダ> [--dry]')
  process.exit(2)
}
const out = args.out
mkdirSync(out, { recursive: true })

const gold = JSON.parse(readFileSync(new URL('./inspect/gold.json', import.meta.url), 'utf8')) as Gold
const sheet = JSON.parse(readFileSync(new URL(`../${gold.sheet}`, import.meta.url), 'utf8')) as Record<string, unknown>
const set = checkSet(gold.checkSet)
const form = toFormDef({ ...readSeed('assessment'), id: 'eval-assessment', version: 1, contentSha: 'eval' })

// 見積もりの単価（worker/vertex/gemini.ts の既定と同じ。円 / 100 万トークン）
const YEN_IN = 119
const YEN_OUT = 593
/** 1 回の答えの字数の見積もり（1 項目 60 字ほど） */
const OUT_PER_ITEM = 60

/** 見積もり用: 答えはいつも段階 2（指示文の字数だけ数える） */
function dryLlm(): Llm {
  const u: Usage = { ...ZERO_USAGE }
  return {
    ask: async (prompt, schema) => {
      const ids = Object.keys((schema as { properties: { results: { properties: Record<string, unknown> } } }).properties.results.properties)
      u.calls++
      u.promptTokens += String(prompt).length
      u.outputTokens += ids.length * OUT_PER_ITEM
      u.yen = (u.promptTokens * YEN_IN + u.outputTokens * YEN_OUT) / 1e6
      return { results: Object.fromEntries(ids.map((id) => [id, { level: '2', met: {}, missing: null }])) }
    },
    usage: () => ({ ...u }),
  }
}
const newLlm = args.dry ? dryLlm : geminiFactory(process.env)

const levelsOf = (fs: Finding[]) => new Map<string, Level | null>(fs.map((f) => [f.item, f.level]))
const run = async (values: Record<string, unknown>) =>
  inspect({ set, docs: [{ id: 'eval-doc', kind: 'assessment', kindName: 'アセスメント', form, values }], llm: newLlm() })

let yen = 0
let calls = 0
const base = await run(sheet)
yen += base.usage.yen
calls += base.usage.calls
writeFileSync(join(out, 'base.json'), JSON.stringify(base.findings, null, 2))
const score = scoreLevels(gold.levels, levelsOf(base.findings))

const ablations = []
for (const a of gold.ablations) {
  const r = await run(applyAblation(sheet, a))
  yen += r.usage.yen
  calls += r.usage.calls
  writeFileSync(join(out, `ablation-${a.id}.json`), JSON.stringify(r.findings, null, 2))
  ablations.push({ id: a.id, why: a.why, results: scoreAblation(a, levelsOf(base.findings), levelsOf(r.findings)) })
}

const report = { dry: args.dry, calls, yen: Math.round(yen * 100) / 100, perInspection: Math.round(base.usage.yen * 100) / 100, score, ablations }
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
console.log(`${args.dry ? '見積もり' : '結果'}: 点検 ${1 + gold.ablations.length} 回、呼び出し ${calls}、${report.yen} 円（点検 1 回 ${report.perInspection} 円）`)
if (!args.dry) {
  console.log(`段階の一致 ${score.exact}/${score.total}（確かな項目 ${score.sure.exact}/${score.sure.total}）、要確認かどうか ${score.needCheck.agree}/${score.total}`)
  console.log(`見落とし（正解は 1）: ${score.needCheck.missed.join('・') || 'なし'}／言いすぎ（正解は 2 以上）: ${score.needCheck.extra.join('・') || 'なし'}`)
  for (const a of ablations) console.log(`${a.id}: ${a.results.map((r) => `${r.id} ${r.before}→${r.after} ${r.ok ? 'OK' : 'NG'}`).join('、')}`)
}
