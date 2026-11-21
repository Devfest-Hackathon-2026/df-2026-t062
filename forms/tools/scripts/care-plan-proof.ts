// 公式の元PDFに架空の見本を印字し、PDF/PNGを出す（生成物はgitに入れない）。
// node forms/tools/scripts/care-plan-proof.ts <出力フォルダ>
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readSeed } from '../../admin/files.ts'
import { ensurePdf } from '../../admin/pdf.ts'
import { basePdfPath, type FormVersion } from '../../../db/forms.ts'
import { LocalStorage } from '../../../api/storage.ts'
import { makePdf } from '../../../api/pdf.ts'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFDocument } from '@pdfme/pdf-lib'

if (!process.argv[2]) throw new Error('出力フォルダを指定してください')
const out = resolve(process.argv[2])
await mkdir(out, { recursive: true })
const storage = new LocalStorage(join(out, 'assets'))
const combined = await PDFDocument.create({ updateMetadata: false })
const values = {
  'person.name': '見本 花子', 'person.birthDate': '1945-04-02', 'person.address': '見本市見本町1番地',
  'office.name': '見本居宅介護支援事業所', 'office.address': '見本市見本町2番地', 'office.careManagerName': '見本 担当者',
  'plan.createdDate': '2026-04-01', 'plan.changedDate': '2026-04-01', 'plan.firstCreatedDate': '2025-04-01', 'plan.kind': '継続',
  'cert.status': '認定済', 'cert.careLevel': '要介護2', 'cert.certifiedDate': '2026-03-15', 'cert.validFrom': '2026-04-01', 'cert.validTo': '2027-03-31',
  'intention.person': '住み慣れた自宅で生活し、買物を続けたい。',
  'intention.family': '本人の希望を尊重し、安全に暮らしてほしい。',
  'plan.intentionAnalysis': '移動時の安全確保と、入浴・買物の支援が必要である。',
  'cert.reviewBoardOpinion': '特記事項なし。',
  'plan.overallPolicy': '本人ができることを生かし、家族とサービス事業所が連携して在宅生活を支える。',
  'plan.livingAssistanceReason': { reason: '一人暮らし' },
  'plan.needs': [{
    need: '安全に入浴したい', longGoal: '自宅での生活を続ける', longGoalPeriod: '2026年4月〜2027年3月',
    shortGoals: [{
      goal: '手すりで浴槽をまたげる', period: '2026年4月〜9月',
      services: [
        { content: '入浴介助と動作の見守り', insured: true, kind: '訪問介護', provider: '見本事業所', frequency: '週2回', period: '2026年4月〜9月' },
        { content: '浴室の手すり', insured: true, kind: '福祉用具貸与', provider: '見本用具', frequency: '常時', period: '2026年4月〜9月' },
      ],
    }],
  }],
  'plan.weekly': [
    { day: '月', start: '09:00', end: '10:00', service: '訪問介護' },
    { day: '木', start: '09:00', end: '10:00', service: '訪問介護' },
    { day: '日', start: '23:00', end: '01:00', service: '夜間の見守り' },
  ],
  'plan.nonWeeklyServices': '福祉用具貸与：月1回の点検',
  dailySchedule: [{ time: '7', rhythm: '朝食' }, { time: '12', rhythm: '昼食' }, { time: '18', rhythm: '夕食' }, { time: '21', rhythm: '就寝' }],
}
for (const no of [1, 2, 3]) {
  const seed = readSeed(`care_plan_${no}`)
  const version: FormVersion = {
    ...seed, id: randomUUID(), templateId: randomUUID(), officeId: null, title: seed.title ?? '',
    version: 1, status: 'published', localFields: [], contentSha: 'proof',
  }
  const base = await ensurePdf(version.kind)
  if (!base.pdf) throw new Error(base.message)
  await storage.writeOnce('forms', basePdfPath(version), base.pdf, 'application/pdf')
  const pdf = await makePdf(storage, version, values)
  await writeFile(join(out, `care-plan-${no}.pdf`), pdf)
  const part = await PDFDocument.load(pdf)
  for (const page of await combined.copyPages(part, part.getPageIndices())) combined.addPage(page)
  const loading = getDocument({ data: new Uint8Array(pdf) })
  const document = await loading.promise
  for (let n = 1; n <= document.numPages; n++) {
    const page = await document.getPage(n)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({ canvasContext: canvas.getContext('2d') as never, viewport }).promise
    await writeFile(join(out, `care-plan-${no}-${n}.png`), canvas.toBuffer('image/png'))
  }
  console.log(`第${no}表: ${document.numPages} ページ`)
  await loading.destroy()
}
await writeFile(join(out, 'care-plan-all.pdf'), await combined.save())
