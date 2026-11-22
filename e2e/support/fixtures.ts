import { test as base, expect, type Page } from '@playwright/test'
import type { CarePlanView } from '../../db/care-plans.ts'

export const headers = { Authorization: 'Bearer dev:e2e@example.com' }
export const test = base.extend<{ clientId: string, clientName: string, ui: 'pc' | 'pad' }>({
  clientName: async ({}, use) => { await use('架空 花子') },
  clientId: async ({ request, clientName }, use) => {
    const response = await request.post('/api/clients', { headers, data: { name: clientName, sex: '女' } })
    expect(response.status()).toBe(201)
    await use((await response.json()).id)
  },
  ui: async ({}, use, info) => { await use(info.project.name.startsWith('ipad-') ? 'pad' : 'pc') },
  page: async ({ page, clientId }, use, info) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // APIのみ同一マシンへ接続。外部AI/Firebaseに依存しない。
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort())
    await page.route('**/__/firebase/init.json', (route) => route.fulfill({ status: 404, body: '' }))
    await page.goto('/')
    await page.getByRole('textbox', { name: 'メールアドレス' }).fill('e2e@example.com')
    const clientsResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' && url.pathname === '/api/clients' && response.status() === 200
    })
    await page.getByRole('button', { name: 'ログイン', exact: true }).click()
    await expect(page.getByRole('heading', { name: /^(担当の利用者|利用者)$/ })).toBeVisible()
    await clientsResponse
    // ui指定なしで実際のタッチ端末判定も検証する。
    await page.goto(`/clients/${clientId}`)
    await expect(page.getByRole('heading', { level: 1 }).or(page.locator('.pad > header'))).toBeVisible()
    await use(page)
    await info.attach('browser-errors', { body: JSON.stringify(errors, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  },
})
export { expect }

export async function openPlan(page: Page, ui: 'pc' | 'pad') {
  if (ui === 'pad') {
    await page.locator('.pad > header').getByRole('button', { name: 'アセスメント', exact: true }).click()
    await page.getByRole('menuitem', { name: /ケアプラン/ }).click()
  } else await page.getByRole('tab', { name: 'ケアプラン', exact: true }).click()
}
export async function createPlan(page: Page, ui: 'pc' | 'pad', effectiveFrom = '2026-04-01') {
  await openPlan(page, ui)
  await page.getByRole('button', {name: '＋ 計画を作る', exact:true}).click()
  const dialog = page.getByRole('dialog', { name: '新しいケアプラン', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('input[type=date]')).toHaveCount(0)
  await page.clock.setFixedTime(new Date(`${effectiveFrom}T01:00:00+09:00`))
  try {
    await dialog.getByRole('button', { name: '第1〜3表を作る' }).click()
    await expect(dialog).not.toBeVisible()
  } finally {
    await page.clock.setFixedTime(new Date())
  }
  await expect(page.getByRole('button', { name: '書類を保存', exact: true })).toBeEnabled()
}
export async function getPlan(page: Page, clientId: string): Promise<CarePlanView> {
  const listed = await page.request.get(`/api/clients/${clientId}/care-plans`, { headers })
  expect(listed.ok()).toBeTruthy()
  const id = (await listed.json()).plans[0].id
  const result = await page.request.get(`/api/care-plans/${id}`, { headers })
  expect(result.ok()).toBeTruthy()
  return (await result.json()).plan
}
export async function save(page: Page) {
  await page.getByRole('button', { name: '書類を保存', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '第1〜3表を保存しました' })).toBeVisible()
}
export async function table(page: Page, number: number) {
  await page.getByRole('tablist', { name: 'ケアプランの書類' }).getByRole('tab', { name: new RegExp(`^第${number}表 `) }).click()
  await expect(page.locator('.sheet-toolbar h2')).toContainText(`第${number}表`)
}
export async function addNeed(page: Page) {
  await table(page, 2)
  await page.getByRole('button', { name: 'ニーズ（押して編集）', exact: true }).click()
  await page.getByRole('button', { name: '＋ ニーズを追加', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '第2表・ニーズ 1', exact: true })
  await dialog.getByLabel('生活全般の解決すべき課題（ニーズ）').fill('安全に入浴したい')
  await dialog.getByLabel('長期目標', { exact: true }).fill('自宅で暮らす')
  await dialog.getByRole('button', { name: '＋ 短期目標を追加' }).click()
  await dialog.getByLabel('短期目標 1', { exact: true }).fill('手すりを使う')
  await dialog.getByRole('button', { name: '＋ サービスを追加' }).click()
  await dialog.getByLabel('サービス内容', { exact: true }).fill('入浴介助')
  await dialog.getByLabel('サービス種別', { exact: true }).fill('訪問介護')
  await dialog.getByLabel('サービス提供を行う事業所（※2）', { exact: true }).fill('架空事業所')
  const covered = dialog.getByRole('checkbox', { name: /保険給付の対象/ })
  await expect(covered).not.toBeChecked()
  await covered.check()
  await dialog.getByLabel('頻度', { exact: true }).fill('週1回')
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click()
  await save(page)
}
export async function addSchedule(page: Page) {
  await table(page, 3)
  await page.getByRole('button', { name: '週間予定（押して編集）', exact: true }).first().click()
  await page.getByRole('button', { name: '＋ 予定を追加', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '第3表・予定の編集', exact: true })
  await dialog.getByLabel('第2表のサービス').selectOption({ index: 1 })
  await dialog.getByLabel('曜日').selectOption('1')
  await dialog.getByLabel('開始', { exact: true }).fill('09:00')
  await dialog.getByLabel('終了', { exact: true }).fill('10:00')
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click()
  await save(page)
}


export async function openCareDocument(page: Page, ui: 'pc' | 'pad', number: 4 | 5 | 6 | 7) {
  const tabs = page.getByRole('tablist', { name: 'ケアプランの書類', exact: true })
  const creating = page.getByRole('dialog', { name: '新しいケアプラン', exact: true })
  if (!await tabs.isVisible()) {
    await openPlan(page, ui)
    await expect(tabs).toBeVisible()
  }
  if (await creating.isVisible()) await creating.getByRole('button', { name: '閉じる', exact: true }).click()
  await tabs.getByRole('tab', { name: new RegExp(`^第${number}表 `) }).click()
}
