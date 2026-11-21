import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSeed } from '../forms/admin/files.ts'
import { checkVersion } from '../db/forms.ts'
import { expandPrintLayout } from '../api/pdf-layout.ts'
import { PdfOverflow } from '../api/pdf-layout.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from '@pdfme/pdf-lib'
import { LocalStorage } from '../api/storage.ts'
import { makePdf } from '../api/pdf.ts'
import { basePdfPath, type FormVersion } from '../db/forms.ts'

test('第1〜3表は独立した公式横A4様式で、欄の対応に食い違いがない', () => {
  for (const no of [1, 2, 3]) {
    const form = readSeed(`care_plan_${no}`)
    assert.deepEqual(checkVersion(form), [])
    assert.equal(form.pages.length, 1)
    assert.equal(form.pages[0].pdfIndex, 0)
    assert.equal(Math.round(form.pages[0].width), 297)
    assert.equal(Math.round(form.pages[0].height), 210)
    assert.equal(form.sourceUrl, 'https://www.mhlw.go.jp/content/001271371.pdf')
    assert.ok(Object.values(form.bindings).some((b) => b.ref.key === 'person.name'))
  }
})

test('最小文字サイズでも収まらない長文は、省略せず overflow にする', () => {
  const form = readSeed('care_plan_1')
  assert.throws(() => expandPrintLayout(form, { 'plan.overallPolicy': '長い文章'.repeat(2000) }), PdfOverflow)
})

test('様式の印字展開に存在しない欄・不正な行数を登録できない', () => {
  const form = readSeed('care_plan_2')
  const page = form.pages[0]
  assert.ok(page.print?.type === 'table')
  page.print.rowsPerPage = 0
  page.print.slots = ['存在しない欄']
  assert.ok(checkVersion(form).some((message) => message.includes('印字設定が不正')))
})

test('pdfmeで第1〜3表の日本語を生成でき、継続ページにも値が残る（合成の元PDF）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'care-plan-pdf-'))
  try {
    const storage = new LocalStorage(root)
    const blank = await PDFDocument.create({ updateMetadata: false })
    blank.addPage([841.89, 595.276]).drawText('SYNTHETIC TEST FORM', { x: 10, y: 580, size: 6 })
    const bytes = await blank.save()
    const sha = createHash('sha256').update(bytes).digest('hex')
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    for (const no of [1, 2, 3]) {
      const seed = readSeed(`care_plan_${no}`)
      const v: FormVersion = {
        ...seed, id: randomUUID(), templateId: randomUUID(), officeId: null, title: seed.title ?? '', version: 1,
        status: 'published', localFields: [], contentSha: 'test', basePdfSha256: sha,
      }
      await storage.writeOnce('forms', basePdfPath(v), bytes, 'application/pdf')
      const pdf = await makePdf(storage, v, {
        'person.name': '見本 太郎', 'plan.overallPolicy': '地域で安全に暮らす',
        'plan.needs': [{ need: '買物に行きたい', longGoal: '外出を続ける', shortGoals: [{
          goal: '安全に移動する', services: Array.from({ length: 7 }, (_, i) => ({ content: `見本サービス${i}`, insured: true })),
        }] }],
        'plan.weekly': [{ day: '月', start: '09:00', end: '10:00', service: '訪問介護' }],
      })
      const loading = getDocument({
        data: new Uint8Array(pdf), useSystemFonts: false,
        standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)),
      })
      const document = await loading.promise
      assert.equal(document.numPages, no === 2 ? 2 : 1)
      let text = ''
      for (let i = 1; i <= document.numPages; i++) text += (await (await document.getPage(i)).getTextContent()).items.map((item) => 'str' in item ? item.str : '').join('')
      assert.ok(text.includes('見本太郎') || text.includes('見本 太郎'), text)
      if (no === 2) {
        assert.ok(text.includes('見本サービス6'), text)
        assert.ok(!text.includes('[object Object]'))
      }
      if (no === 3) assert.ok(text.includes('訪問介護'), text)
      await loading.destroy()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('第2表はサービスごとに改ページし、空の短期目標でもニーズを落とさない', () => {
  const form = readSeed('care_plan_2')
  const pages = expandPrintLayout(form, {
    'person.name': '見本 太郎',
    'plan.needs': [
      { need: '外出したい', longGoal: '地域生活を続ける', shortGoals: [{
        goal: '安全に移動する', services: Array.from({ length: 12 }, (_, i) => ({ content: `サービス${i}`, insured: true })),
      }] },
      { need: '相談を続けたい', longGoal: '相談先を確保', shortGoals: [] },
    ],
  })
  assert.equal(pages.length, 3)
  const text = pages.flatMap((p) => p.schemas.map((s) => p.input[s.name])).join('\n')
  for (let i = 0; i < 12; i++) assert.ok(text.includes(`サービス${i}`))
  assert.ok(text.includes('相談を続けたい'))
  assert.ok(pages.every((p) => p.input['利用者名'] === '見本 太郎'))
})

test('第3表は時間軸に配置し、同時提供を省略せず、翌日終了は翌曜日にも印字する', () => {
  const form = readSeed('care_plan_3')
  const pages = expandPrintLayout(form, {
    'plan.weekly': [
      { day: '日', start: '23:30', end: '01:00', service: '夜間サービス' },
      { day: '月', start: '00:15', end: '00:45', service: '別サービス' },
    ],
    dailySchedule: [{ time: '7', rhythm: '朝食', family: '印字しない家族援助' }],
  })
  assert.equal(pages.length, 2)
  const slots = pages.flatMap((p) => p.schemas.filter((s) => s.name.startsWith('週間枠__')).map((s) => ({ slot: s, text: p.input[s.name] })))
  assert.equal(slots.length, 3)
  assert.ok(slots.some((s) => s.text.replace(/\s/g, '').includes('翌01:00')))
  assert.ok(slots.some((s) => s.text.includes('前日から')))
  assert.ok(pages[0].input['日常生活活動'].includes('朝食'))
  assert.ok(!pages[0].input['日常生活活動'].includes('家族援助'))
  assert.ok(slots.every(({ slot }) => slot.position.y >= 39.5 && slot.position.y + slot.height <= 154.1 + 0.001))
})
