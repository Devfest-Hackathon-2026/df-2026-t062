// 様式の取り込み（#99）の精度を測る道具。ワーカーの変換（worker/form-import/convert.ts）で 1 ページを変換し、
// 手で作った版があれば比べる（compare.ts）。本物の Gemini を呼ぶので費用がかかる（評価用のプロジェクトで流す）。
//
//   node forms/tools/import/try.ts --form admission --page 1 [--tag 名前]            … 手で作った版（forms/seed/<様式>）と比べる
//   node forms/tools/import/try.ts --form 名前 --pdf <PDF> --page 1 [--tag 名前]     … 手で作った版のない用紙（比べずに答えを残す）
//
// 元の PDF は forms/tools/templates/<様式>/base.pdf（npm run forms:fetch）。
// 出力: forms/tools/out/import/<様式>_p<ページ>[_<tag>].json（答え・比べた結果・使った量と円）。様式の中身が入るので git には入れない。
// 必要なもの: gcloud の ADC、GOOGLE_CLOUD_PROJECT。
// 予算: 呼ぶたびに forms/tools/out/import/spend.jsonl に円を足し、合計＋1 回の見込み（CALL_ESTIMATE_YEN）が BUDGET_YEN（既定 30000）を超えるなら呼ばない。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { geminiFactory, type Ask } from '../../../worker/vertex/gemini.ts'
import { convertPage } from '../../../worker/form-import/convert.ts'
import { openPdf } from '../../../worker/form-import/pdf.ts'
import { catalog } from '../../../worker/form-import/prompt.ts'
import { checkBudget, compareDraft, spentYen } from './compare.ts'

/** 1 回の呼び出しの見込み（多めに見た上限。試しでは 1 回 4〜15 円） */
const CALL_ESTIMATE_YEN = 18

const { values: arg } = parseArgs({ options: { form: { type: 'string', default: 'admission' }, page: { type: 'string', default: '1' }, pdf: { type: 'string' }, tag: { type: 'string', default: '' } } })
const form = arg.form!
const pageNo = Number(arg.page)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const outDir = join(root, 'forms/tools/out/import')
mkdirSync(outDir, { recursive: true })
const ledger = join(outDir, 'spend.jsonl')
const budget = Number(process.env.BUDGET_YEN ?? 30000)
const project = process.env.GOOGLE_CLOUD_PROJECT
if (!project) throw new Error('GOOGLE_CLOUD_PROJECT がありません（費用のかかる試しは評価用のプロジェクトで）')

const llm = geminiFactory(process.env)()
let recorded = 0
const ask: Ask = async (prompt, schema, meta) => {
  checkBudget(existsSync(ledger) ? spentYen(readFileSync(ledger, 'utf8')) : 0, CALL_ESTIMATE_YEN, budget)
  try {
    return await llm.ask(prompt, schema, meta)
  } finally {
    const yen = llm.usage().yen - recorded
    recorded += yen
    appendFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), project, form, page: pageNo, tag: arg.tag, step: meta.step, yen }) + '\n')
  }
}

const pdf = await openPdf(new Uint8Array(readFileSync(arg.pdf ?? join(root, 'forms/tools/templates', form, 'base.pdf'))))
const t0 = Date.now()
try {
  const d = await convertPage(pdf, pageNo, { ask, catalog: catalog() })
  const usage = { ...llm.usage(), seconds: (Date.now() - t0) / 1000 }
  const seed = join(root, 'forms/seed', form)
  const cmp = existsSync(seed) && !arg.pdf
    ? compareDraft(d.slots, { schemas: JSON.parse(readFileSync(join(seed, 'template.json'), 'utf8')).schemas[pageNo - 1], bindings: JSON.parse(readFileSync(join(seed, 'bindings.json'), 'utf8')) })
    : null
  writeFileSync(join(outDir, `${form}_p${pageNo}${arg.tag ? `_${arg.tag}` : ''}.json`), JSON.stringify({ usage, ...d, comparison: cmp }, null, 2))

  console.log(JSON.stringify(usage))
  console.log(`見直し: ${d.rounds.map((r, i) => `${i + 1} 回目 足した ${r.added}・直した ${r.fixed}・取り除いた ${r.removed}`).join(' ／ ')}`)
  console.log(`マス ${d.cells.length}、□ ${d.boxes.length}、事業所だけの欄の定義 ${d.localFields.length}、要確認 ${d.problems.length}${d.problems.length ? `: ${d.problems.join(' / ')}` : ''}`)
  if (!cmp) {
    const nLocal = d.slots.filter((x) => x.ref === null || x.ref.startsWith('local.')).length
    console.log(`手の版なし。AI の欄 ${d.slots.length}（ページの外で捨てた欄 ${d.outside}）、key あり ${d.slots.length - nLocal}、事業所だけの欄 ${nLocal}`)
  } else {
    const pct = (n: number, m: number) => `${n}/${m}（${m ? Math.round(n / m * 100) : 0}%）`
    console.log(`手の版の欄 ${cmp.hand}、AI の欄 ${cmp.ai}（ページの外で捨てた欄 ${d.outside}）`)
    console.log(`見つけた欄: ${pct(cmp.found, cmp.hand)}、手の版にない欄: ${cmp.extra}`)
    console.log(`左上のずれ（見つけた欄のうち）: 0.3mm 以内 ${pct(cmp.within.mm03, cmp.found)}、1mm 以内 ${pct(cmp.within.mm1, cmp.found)}、3mm 以内 ${pct(cmp.within.mm3, cmp.found)}`)
    console.log(`key が合った: ${pct(cmp.refMatch, cmp.found)}、印の表すものが合った: ${pct(cmp.optionMatch, cmp.optionTotal)}`)
  }
} finally {
  await pdf.close()
}
