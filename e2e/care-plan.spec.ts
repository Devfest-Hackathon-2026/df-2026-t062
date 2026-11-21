import { readFile, writeFile } from 'node:fs/promises'
import { PDFDocument } from '@pdfme/pdf-lib'
import { test, expect, headers, createPlan, openPlan, getPlan, save, table, addNeed, addSchedule } from './support/fixtures.ts'

test('3表を作成・編集・一括保存し、再表示・PDF・確定・改定まで進める', async ({ page, clientId, ui, clientName }) => {
  await createPlan(page, ui)
  const policy = page.getByRole('textbox', { name: '総合的援助方針', exact: true })
  await policy.fill('地域で安全に暮らせるよう支援する。')
  await policy.blur()
  await save(page)
  const initiallySaved = await getPlan(page, clientId)
  expect(initiallySaved.status).toBe('draft')
  expect(initiallySaved.plan1['plan.overallPolicy']).toBe('地域で安全に暮らせるよう支援する。')
  await addNeed(page)
  await addSchedule(page)
  // 第2・3表の氏名は第1表から独立し、生活リズムも保存される。
  await page.getByRole('textbox', { name: /^利用者名（/ }).fill('確認 花子')
  await page.getByRole('textbox', { name: /^利用者名（/ }).blur()
  await page.getByRole('button', { name: '主な日常生活上の活動を編集', exact: true }).click()
  const activities = page.getByRole('dialog', { name: '第3表・主な日常生活上の活動', exact: true })
  await activities.getByRole('button', { name: '＋ 生活時間を追加' }).click()
  await activities.getByLabel('時刻').selectOption('7')
  await activities.getByLabel('本人の生活リズム').fill('朝食')
  await activities.getByRole('button', { name: '閉じる', exact: true }).click()
  await save(page)
  const persisted = await getPlan(page, clientId)
  expect(persisted.hasUnsavedChanges).toBe(false)
  expect(persisted.documents.every((d) => d.latestRevision > 0)).toBe(true)
  expect(new Set(persisted.documents.map((d) => d.latestRevision)).size).toBe(1)
  expect(persisted.needs[0].shortGoals[0].services[0].content).toBe('入浴介助')
  expect(persisted.slots[0]).toMatchObject({ weekday: 1, start: '09:00', end: '10:00' })

  await page.reload()
  await openPlan(page, ui)
  await expect(page.getByRole('button', { name: '計画を確定', exact: true })).toBeEnabled()
  await expect(policy).toHaveValue('地域で安全に暮らせるよう支援する。')
  await expect(page.getByRole('textbox', { name: /^利用者名（/ })).toHaveValue(clientName)
  await table(page, 2)
  await expect(page.getByRole('button', { name: 'サービス内容（押して編集）', exact: true })).toHaveText('入浴介助')
  await table(page, 3)
  await expect(page.getByRole('textbox', { name: /^利用者名（/ })).toHaveValue('確認 花子')
  await expect(page.getByRole('button', { name: '週間枠（押して編集）', exact: true })).toContainText('09:00')

  const pdfResponse = page.waitForResponse((r) => r.url().includes(`/api/care-plans/${persisted.id}/pdf`))
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '書類を出力', exact: true }).click()
  expect((await pdfResponse).status()).toBe(200)
  const download = await downloading
  expect(download.suggestedFilename()).toContain('第1版.pdf')
  const pdf = await PDFDocument.load(await readFile((await download.path())!))
  expect(pdf.getPageCount()).toBe(3)

  await page.getByRole('button', { name: '計画を確定', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '計画を確定しますか？', exact: true })
  await confirm.getByRole('button', { name: '第1〜3表を確定する' }).click()
  await expect(confirm).not.toBeVisible()
  expect((await getPlan(page, clientId)).status).toBe('confirmed')
  for (const number of [1, 2, 3]) {
    await table(page, number)
    await expect(page.getByRole('textbox', { name: /^利用者名（/ })).toBeDisabled()
    await expect(page.getByRole('button', { name: '書類を保存', exact: true })).toBeDisabled()
  }
  await page.getByRole('button', { name: 'この計画をもとに改定版を作る' }).click()
  await page.getByRole('dialog', { name: '改定版を作る', exact: true }).getByRole('button', { name: '第1〜3表を作る' }).click()
  await expect(policy).toBeEditable()
  const revised = await getPlan(page, clientId)
  expect(revised).toMatchObject({ version: 2, status: 'draft', previousPlanId: persisted.id })
  expect(revised.needs[0].shortGoals[0].services[0].id).not.toBe(persisted.needs[0].shortGoals[0].services[0].id)
  expect(revised.slots[0].serviceId).toBe(revised.needs[0].shortGoals[0].services[0].id)
})

test('未保存の移動・保存失敗・PDFの長文エラーで成功扱いにせず再試行できる', async ({ page, clientId, ui }) => {
  await createPlan(page, ui)
  const policy = page.getByRole('textbox', { name: '総合的援助方針', exact: true })
  await policy.fill('保存に失敗しても残す入力')
  await policy.blur()
  const plan = await getPlan(page, clientId)
  await page.route(`**/api/care-plans/${plan.id}/save`, async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'e2e_save_failure' }) })
  }, { times: 1 })
  await page.getByRole('button', { name: '書類を保存', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(policy).toHaveValue('保存に失敗しても残す入力')
  await expect(page.getByRole('button', { name: '書類を出力', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '計画を確定', exact: true })).toBeDisabled()
  await expect(page.getByRole('status').filter({ hasText: '第1〜3表を保存しました' })).toHaveCount(0)
  expect((await getPlan(page, clientId)).documents.every((d) => d.latestRevision === 0)).toBe(true)
  page.once('dialog', (dialog) => dialog.dismiss())
  if (ui === 'pc') await page.getByRole('tab', { name: 'アセスメント', exact: true }).click()
  else await page.getByRole('button', { name: '← 書類に戻る', exact: true }).click()
  await expect(policy).toHaveValue('保存に失敗しても残す入力')
  await save(page)
  // 自動送信済みでも、保存版と異なる間はPDFを出力できない。
  const tooLong = '長い文章'.repeat(2000)
  await policy.fill(tooLong)
  await policy.blur()
  await expect.poll(async () => (await getPlan(page, clientId)).plan1['plan.overallPolicy']).toBe(tooLong)
  await expect(page.getByRole('button', { name: '書類を出力', exact: true })).toBeDisabled()
  await save(page)
  const overflow = page.waitForResponse((r) => r.url().includes(`/api/care-plans/${plan.id}/pdf`))
  await page.getByRole('button', { name: '書類を出力', exact: true }).click()
  expect((await overflow).status()).toBe(422)
  await expect(page.getByRole('alert')).toContainText('用紙の印字欄')
  await expect(page.getByRole('alert')).toContainText('総合的援助方針')
  await policy.fill('短く訂正した方針')
  await policy.blur()
  await save(page)
  const success = page.waitForResponse((r) => r.url().includes(`/api/care-plans/${plan.id}/pdf`))
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '書類を出力', exact: true }).click()
  expect((await success).status()).toBe(200)
  await downloading
})

test('実際のviewportで3表・拡大・ダイアログが欠けず、上部配置が揃う', async ({ page, ui, clientName, browser }, info) => {
  const viewport = page.viewportSize()!
  expect(await page.evaluate(() => innerWidth)).toBe(viewport.width)
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(ui === 'pad')
  let assessmentTop = 0
  if (ui === 'pc') {
    assessmentTop = (await page.locator('.sheet-toolbar').boundingBox())!.y
    const entry = page.getByRole('button', { name: 'ケアプランを作成', exact: true })
    expect(await entry.evaluate((e) => e.closest('[role="tablist"]') === null)).toBe(true)
    const entryBox = (await entry.boundingBox())!
    expect(entryBox.x).toBeGreaterThan(viewport.width * .7)
  }
  await createPlan(page, ui)
  const initialCanvas = (await page.locator('.cp-canvas').boundingBox())!
  expect(initialCanvas.y).toBeLessThan(ui === 'pad' ? viewport.height * .45 : viewport.height - 220)
  await expect(page.getByRole('textbox', { name: /^利用者名（/ })).toHaveValue(clientName)
  if (ui === 'pc') expect(Math.abs((await page.locator('.sheet-toolbar').boundingBox())!.y - assessmentTop)).toBeLessThan(2)
  const metrics = { browser: browser.version(), project: info.project.name, viewport, displays: [] as unknown[] }
  for (const number of [1, 2, 3]) {
    await table(page, number)
    const image = page.locator('.cp-canvas img').first()
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const canvas = (await page.locator('.cp-canvas').boundingBox())!
    expect(canvas.width).toBeGreaterThan(600)
    if (ui === 'pc') {
      const assistant = (await page.locator('.assistant-panel').boundingBox())!
      const nav = (await page.locator('.cp-nav').boundingBox())!
      expect(nav.x + nav.width).toBeLessThan(canvas.x)
      expect(canvas.x + canvas.width).toBeLessThan(assistant.x)
    }
    const outOfPaper = await page.locator('.cp-canvas .pg').evaluateAll((papers) => papers.flatMap((paper) => {
      const bounds = paper.getBoundingClientRect()
      return [...paper.querySelectorAll('input, textarea, .cp-paper-field')].filter((field) => {
        const box = field.getBoundingClientRect()
        return box.left < bounds.left - 1 || box.top < bounds.top - 1 || box.right > bounds.right + 1 || box.bottom > bounds.bottom + 1
      }).map((field) => field.getAttribute('aria-label'))
    }))
    expect(outOfPaper).toEqual([])
    // タッチ用のmin-heightが用紙上の単行欄に混入すると、値はあっても文字が隠れる。
    const clippedInputs = await page.locator('.cp-canvas .pg input').evaluateAll((inputs) => inputs.filter((input) => {
      const field = input as HTMLInputElement
      return field.value && field.getBoundingClientRect().height > field.parentElement!.getBoundingClientRect().height + 1
    }).map((input) => input.getAttribute('aria-label')))
    expect(clippedInputs).toEqual([])
    const toolbar = (await page.locator('.sheet-toolbar').boundingBox())!
    const saveBox = (await page.getByRole('button', { name: '書類を保存', exact: true }).boundingBox())!
    expect(saveBox.x + saveBox.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1)
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(toolbar.y + toolbar.height + 1)
    metrics.displays.push(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, inputs: [...document.querySelectorAll<HTMLInputElement>('.cp-canvas .pg input')].filter((e) => e.value).map((e) => ({ value: e.value, fontSize: getComputedStyle(e).fontSize, lineHeight: getComputedStyle(e).lineHeight, height: e.getBoundingClientRect().height })) })))
    await page.screenshot({ path: info.outputPath(`table-${number}-${viewport.width}x${viewport.height}.png`), fullPage: true })
    await info.attach(`table-${number}`, { path: info.outputPath(`table-${number}-${viewport.width}x${viewport.height}.png`), contentType: 'image/png' })
  }
  const metricsPath = info.outputPath('display-metrics.json')
  await writeFile(metricsPath, JSON.stringify(metrics, null, 2))
  await info.attach('display-metrics', { path: metricsPath, contentType: 'application/json' })
  await page.getByRole('button', { name: '大きくする', exact: true }).click()
  await expect(page.locator('.sheet-zoom')).toContainText('120%')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.getByRole('button', { name: '小さくする', exact: true }).click()
  await expect(page.locator('.sheet-zoom')).toContainText('100%')
  await page.getByRole('button', { name: '予定を追加・編集', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '第3表・予定の追加と選択', exact: true })
  await expect(dialog).toBeVisible()
  const box = (await dialog.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click()
})


test('候補ありAI原案を再開し、サービスと週間予定を対応付けて適用・保存する', async ({ page, clientId, ui }) => {
  let generations = 0
  page.on('request', (request) => { if (request.method() === 'POST' && /\/ai-drafts$/.test(request.url())) generations++ })
  const client = await (await page.request.get(`/api/clients/${clientId}`, { headers })).json()
  const documentId = client.client.documents.find((d: { kind: string }) => d.kind === 'assessment').id
  const saved = await page.request.post(`/api/documents/${documentId}/save`, { headers, data: { scope: 'document' } })
  expect(saved.ok()).toBeTruthy()
  await createPlan(page, ui)
  await save(page)
  await page.getByRole('button', { name: 'AI原案を作る', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '保存済みアセスメントからAI原案を作る', exact: true })
  await dialog.getByLabel('参照するアセスメント').selectOption({ index: 1 })
  await dialog.getByRole('button', { name: '原案を作る', exact: true }).click()
  await expect(dialog).toContainText('第3表の候補：架空の入浴介助')
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click()
  await page.getByRole('button', { name: '前回のAI原案を開く', exact: true }).click()
  await expect(dialog).toContainText('架空の方針：自宅で安全に暮らす')
  expect(generations).toBe(1)
  await dialog.getByRole('button', { name: 'この原案を入力する', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'AI原案を3項目入力しました' })).toBeVisible()
  let plan = await getPlan(page, clientId)
  expect(plan.slots).toHaveLength(1)
  expect(plan.slots[0].serviceId).toBe(plan.needs[0].shortGoals[0].services[0].id)
  expect(plan.status).toBe('draft')
  await save(page)
  await page.reload()
  await openPlan(page, ui)
  await table(page, 3)
  plan = await getPlan(page, clientId)
  expect(plan.slots[0].start).toBe('09:00')
  expect(plan.hasUnsavedChanges).toBe(false)
})

test('ケアプランとの往復で相談履歴と参照元を保つ', async ({ page, clientId, ui }) => {
  test.skip(ui !== 'pc', '右側の既存相談パネルはPCの導線')
  const assistant = page.locator('aside.assistant-panel')
  await assistant.getByRole('button', { name: '書き方を相談する', exact: true }).click()
  await assistant.getByRole('textbox', { name: '相談内容' }).fill('文章について相談します')
  await assistant.getByRole('button', { name: '送る', exact: true }).click()
  await expect(assistant.locator('.assistant-chat-user')).toContainText('文章について相談します')
  await expect(assistant.locator('.assistant-chat-thinking')).toHaveCount(0)
  await createPlan(page, ui)
  await expect(assistant.locator('.assistant-chat-user')).toContainText('文章について相談します')
  const plan = await getPlan(page, clientId)
  await page.getByRole('tab', { name: 'アセスメント', exact: true }).click()
  await expect(assistant.locator('.assistant-chat-user')).toContainText('文章について相談します')
  const current = await getPlan(page, clientId)
  expect(current.plan1).toEqual(plan.plan1)
  expect(current.needs).toEqual(plan.needs)
  expect(current.slots).toEqual(plan.slots)
})
