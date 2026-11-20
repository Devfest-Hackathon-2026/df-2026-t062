// 架空の検証資料だけを通常の取込ジョブへ通す。--live がなければ Gemini は呼ばない。
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { PDFDocument } from '@pdfme/pdf-lib'
import { documentInputPath, type DocumentInputResult, type DocumentMime } from '../../core/document-input.ts'
import { spec } from '../../core/fields.ts'
import { sameValue } from '../../core/apply-batch.ts'
import { SURVEY_IMPORT_KEYS, surveyChoice } from '../../core/survey-import.ts'
import { createPool } from '../../db/pool.ts'
import { migrate } from '../../db/migrate.ts'
import { seed } from '../../db/seed.ts'
import { createClient } from '../../db/repo.ts'
import { startInput, completeInput, inputView } from '../../db/document-inputs.ts'
import { LocalStorage } from '../../api/storage.ts'
import { runDocumentInput } from '../../worker/document-input/job.ts'
import { readRowMarks } from '../../src/survey/marks.ts'
import { openPdf } from '../../worker/form-import/pdf.ts'
import { vertexProviders } from '../../worker/vertex/index.ts'
import { geminiFactory, type Llm } from '../../worker/vertex/gemini.ts'
import { summarizer } from '../../worker/vertex/summarizer.ts'
import { topicWriter } from '../../worker/vertex/topic-writer.ts'
import { ZERO_USAGE, type Usage } from '../../worker/types.ts'

export interface Gold { key: string, expected: unknown, review: boolean }
/** 欠落と誤った候補を分ける。要確認の欄は候補を出さず、要確認の記録があるときだけ成功。 */
export function score(result: DocumentInputResult, gold: Gold[]) {
  const candidates = new Map(result.candidates.map((c) => [c.key, c]))
  let exact = 0, wrong = 0, missing = 0, safeReview = 0
  for (const item of gold) {
    const candidate = candidates.get(item.key)
    if (item.review) {
      const itemNumber = item.key.replace('survey.', '').replace('_', '-')
      const label = spec(item.key)?.label.replace(/^\S+\s*/, '')
      const relevant = [...result.issues.map((issue) => issue.text), ...result.evidence.filter((e) => e.uncertain).map((e) => e.text)]
        .some((text) => text.includes(itemNumber) || !!label && text.includes(label))
      if (!candidate && relevant) safeReview++
      else if (candidate) wrong++
      else missing++
    } else if (!candidate) missing++
    else {
      const multi = spec(item.key)?.type === 'multi'
      const proposed = multi && Array.isArray(candidate.value) ? [...candidate.value].sort() : candidate.value
      const expected = multi && Array.isArray(item.expected) ? [...item.expected].sort() : item.expected
      if (sameValue(proposed, expected)) exact++
      else wrong++
    }
  }
  const refs = new Set(result.evidence.filter((e) => !e.uncertain).map((e) => e.id))
  const withEvidence = result.candidates.filter((c) => c.cite.length && c.cite.every((id) => refs.has(id))).length
  return { total: gold.length, exact, wrong, missing, safeReview, candidateCount: result.candidates.length, withEvidence,
    evidenceCoverage: result.candidates.length ? withEvidence / result.candidates.length : null }
}

async function baseline(file: Uint8Array) {
  const pdf = await openPdf(file)
  try {
    const page = await pdf.layout(2)
    if (!page.chars.length) return { status: 'unsupported_scan' }
    const image = await loadImage(await pdf.png(2, 216))
    const canvas = createCanvas(image.width, image.height)
    canvas.getContext('2d').drawImage(image, 0, 0)
    const pixels = canvas.getContext('2d').getImageData(0, 0, image.width, image.height)
    const values: Record<string, unknown> = {}
    for (const [i, label] of ['2.移動', '4.食事摂取', '5.排尿'].entries()) {
      const anchor = page.words.find((w) => w.t.normalize('NFKC').replace(/\s/g, '') === label && w.x0 < 23)
      if (!anchor) return { status: 'unsupported_layout' }
      const char = page.chars.find((c) => Math.abs(c.x0 - anchor.x0) < .1 && Math.abs(c.y0 - anchor.y0) < .1)!
      const marks = readRowMarks(pixels as unknown as ImageData, char.b * 72 / 25.4 * 3, 3)
      const selected = marks.flatMap((m, index) => m === 'empty' ? [] : [index + 1])
      values[SURVEY_IMPORT_KEYS[i]] = selected.length === 1 && marks[selected[0] - 1] === 'clear' ? surveyChoice(SURVEY_IMPORT_KEYS[i], selected[0]) : null
    }
    return { status: 'read', values }
  } finally { await pdf.close() }
}

async function prepare(fixtures: string, requested: Set<string>) {
  const manifest = JSON.parse(await readFile(join(fixtures, 'manifest.json'), 'utf8'))
  const goldBytes = await readFile(new URL('./survey/gold.tsv', import.meta.url))
  if (manifest.synthetic !== true || manifest.goldSha256 !== createHash('sha256').update(goldBytes).digest('hex')) throw new Error('make_fixtures.py で現在の正解表の架空資料を生成してください')
  for (const name of ['survey-clean.pdf', 'survey-difficult.pdf', ...(requested.has('blank') ? ['survey-blank.pdf'] : []), ...(requested.has('osaka') ? ['osaka.pdf'] : [])]) {
    const bytes = await readFile(join(fixtures, name))
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[name]) throw new Error('生成後に検証資料が変更されています')
  }
  const clean = await readFile(join(fixtures, 'survey-clean.pdf'))
  const original = await openPdf(clean)
  try {
    const first = (await original.layout(1)).words.map((w) => w.t).join('')
    if (!first.includes('架空の検証資料')) throw new Error('評価用に生成した架空資料を指定してください')
    const scan = await PDFDocument.create()
    for (let page = 1; page <= original.numPages; page++) {
      const layout = await original.layout(page)
      const png = await scan.embedPng(await original.png(page, 120))
      scan.addPage([layout.width * 72 / 25.4, layout.height * 72 / 25.4]).drawImage(png, {
        x: 0, y: 0, width: layout.width * 72 / 25.4, height: layout.height * 72 / 25.4,
      })
    }
    await writeFile(join(fixtures, 'survey-scan.pdf'), await scan.save())
  } finally { await original.close() }
  GlobalFonts.registerFromPath(fileURLToPath(new URL('../../forms/fonts/BIZUDPGothic-Regular.ttf', import.meta.url)), 'EvalJP')
  for (const [name, mime, title] of [['discharge.png', 'image/png', '退院時の引継ぎ'], ['opinion.jpg', 'image/jpeg', '主治医意見書の別紙']] as const) {
    const canvas = createCanvas(1400, 850)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1400, 850)
    ctx.fillStyle = 'black'; ctx.font = '32px EvalJP'
    for (const [i, text] of [title, '架空の検証資料・提出不可', '対象者：検証 太郎　記録日：2026年11月4日',
      '2-2 移動：見守り等。歩行器を使い、家族が横につく。', '2-4 食事摂取：見守り等。家族が声をかける。',
      '2-5 排尿：一部介助。下衣を上げるときに家族が介助する。'].entries()) ctx.fillText(text, 45, 90 + i * 95)
    const bytes = mime === 'image/png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg')
    await writeFile(join(fixtures, name), bytes)
  }
}

export async function main() {
  const { values: args } = parseArgs({ options: {
    fixtures: { type: 'string' }, out: { type: 'string' }, live: { type: 'boolean', default: false },
    cases: { type: 'string', default: 'clean' }, 'budget-yen': { type: 'string', default: '50' }, concurrency: { type: 'string', default: '1' },
  } })
  if (!args.fixtures || !args.out) throw new Error('--fixtures と --out を指定してください')
  const fixtures = resolve(args.fixtures), output = resolve(args.out)
  const budget = Number(args['budget-yen'])
  const concurrency = Number(args.concurrency)
  if (!Number.isFinite(budget) || budget <= 0 || budget > 200) throw new Error('budget-yen は0より大きく200以下にしてください')
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('concurrency は1〜4にしてください')
  const requested = new Set(args.cases!.split(','))
  if ([...requested].some((id) => !['clean', 'difficult', 'blank', 'scan', 'png', 'jpeg', 'osaka'].includes(id))) throw new Error('cases は clean,difficult,blank,scan,png,jpeg,osaka から選んでください')
  await mkdir(output, { recursive: true })
  await prepare(fixtures, requested)
  const all = [
    { id: 'clean', file: 'survey-clean.pdf', mime: 'application/pdf' },
    { id: 'difficult', file: 'survey-difficult.pdf', mime: 'application/pdf' },
    { id: 'blank', file: 'survey-blank.pdf', mime: 'application/pdf' },
    { id: 'scan', file: 'survey-scan.pdf', mime: 'application/pdf' },
    { id: 'png', file: 'discharge.png', mime: 'image/png' },
    { id: 'jpeg', file: 'opinion.jpg', mime: 'image/jpeg' },
    { id: 'osaka', file: 'osaka.pdf', mime: 'application/pdf' },
  ] as const
  const cases = [...requested].map((id) => all.find((item) => item.id === id)!)
  const gold = (await readFile(new URL('./survey/gold.tsv', import.meta.url), 'utf8')).trim().split('\n').slice(1).map((line) => {
    const columns = line.split('\t')
    return { key: columns[5], expected: JSON.parse(columns[6]), review: false }
  })
  const baselineResults: Record<string, unknown> = {}
  for (const item of cases.filter((c) => c.mime === 'application/pdf')) {
    const t0 = performance.now()
    try { baselineResults[item.id] = { ...await baseline(await readFile(join(fixtures, item.file))), elapsedMs: Math.round(performance.now() - t0) } }
    catch { baselineResults[item.id] = { status: 'read_failed' } }
  }
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), syntheticOnly: true, live: args.live,
    model: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash', location: process.env.GEMINI_LOCATION ?? 'global',
    concurrency, cases: cases.map((c) => c.id), budgetYen: budget, baseline: baselineResults, results: {}, humanConfirmationTimeMs: null }
  if (!args.live) {
    report.estimate = { perCaseYen: '20〜50程度（入力と出力に依存する見積もり）', note: 'liveでは予算に達したら次の呼出を止める。実行中1呼出分は超過しうる。' }
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2)); return
  }
  if (!process.env.DATABASE_URL || !process.env.GOOGLE_CLOUD_PROJECT || process.env.DOCUMENT_INPUT_APPROVED_LOCATION !== (process.env.GEMINI_LOCATION ?? 'global')) throw new Error('DB・GCPプロジェクト・処理地域を設定してください')
  const llms: Llm[] = []
  const usage = (): Usage => Object.fromEntries(Object.keys(ZERO_USAGE).map((key) => [key, llms.reduce((n, llm) => n + llm.usage()[key as keyof Usage], 0)])) as unknown as Usage
  const factory = geminiFactory(process.env)
  const diagnostics: { step: string, name: string, status: number | null }[] = []
  let responseNumber = 0
  let limited = false
  const newLlm = (): Llm => {
    const llm = factory(); llms.push(llm)
    return { usage: llm.usage, ask: async (...input) => {
      if (usage().yen >= budget) { limited = true; throw new Error('evaluation_budget_reached') }
      try {
        const result = await llm.ask(...input)
        await writeFile(join(output, `synthetic-response-${++responseNumber}.json`), JSON.stringify({ step: input[2].step, response: result }, null, 2))
        return result
      }
      catch (e) {
        const error = e as Error & { status?: number }
        diagnostics.push({ step: input[2].step, name: error.name, status: error.status ?? null })
        // 架空資料の評価で失敗した API の診断だけを、git 管理外の評価先へ残す。
        await writeFile(join(output, 'synthetic-api-error.txt'), String(error.message))
        throw e
      }
    } }
  }
  const providers = vertexProviders(process.env)
  providers.documentRead = newLlm
  providers.documentWrite = { summarizer: summarizer(newLlm), writer: topicWriter(newLlm, { concurrency }) }
  const schema = `eval_document_${process.pid}_${Date.now()}`
  const admin = await createPool()
  await admin.query(`CREATE SCHEMA ${schema}`); await admin.end()
  const db = await createPool({ ...process.env, DB_SCHEMA: schema })
  const storage = new LocalStorage(join(output, 'storage'))
  try {
    await migrate(db)
    const { staff } = await seed(db)
    for (const item of cases) {
      if (limited || usage().yen >= budget) { limited = true; break }
      const file = await readFile(join(fixtures, item.file))
      const created = await createClient(db, staff, { name: '検証 太郎' })
      const started = await startInput(db, staff, created.documentId, { fileName: item.file, mime: item.mime as DocumentMime, bytes: file.length, sha256: createHash('sha256').update(file).digest('hex') }, storage)
      await storage.writeOnce('source', documentInputPath(staff.officeId, created.id, started.input.id), file)
      await completeInput(db, staff, started.input.id, storage)
      const t0 = Date.now()
      let failed = false
      try { await runDocumentInput({ db: async () => db, storage: () => storage, providers: async () => providers }, started.input.id) }
      catch { failed = true }
      const view = await inputView(db, staff, started.input.id)
      const expected = item.id === 'png' || item.id === 'jpeg' || item.id === 'osaka' ? gold.filter((g) => SURVEY_IMPORT_KEYS.includes(g.key as never))
        : gold.map((g) => ({ ...g, review: item.id === 'difficult' && ['survey.2_2', 'survey.2_4'].includes(g.key) || item.id === 'blank' && g.key === 'survey.2_5' }))
      const result = { sha256: createHash('sha256').update(file).digest('hex'), status: view.status, errorKind: view.errorKind, failed, elapsedMs: Date.now() - t0,
        metrics: view.result ? score(view.result, expected) : null, usage: view.result?.usage ?? null }
      const results = report.results as Record<string, unknown>
      results[item.id] = result
      // 中間結果は架空資料に限り保存する。実資料の本文や応答を評価用に保存しない。
      const row = (await db.query('SELECT pages,summary_bundle FROM document_inputs WHERE id=$1', [view.id])).rows[0]
      await writeFile(join(output, `${item.id}-synthetic.json`), JSON.stringify({ ...row, result: view.result }, null, 2))
      report.totalUsage = usage(); report.budgetReached = limited || usage().yen >= budget; report.diagnostics = diagnostics
      await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
      console.log(JSON.stringify({ case: item.id, ...result }))
      if (failed || view.status !== 'review') { process.exitCode = 1; break }
    }
  } finally {
    await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end()
    await rm(join(output, 'storage'), { recursive: true, force: true })
  }
  console.log(JSON.stringify({ usage: usage(), budgetReached: limited }))
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
