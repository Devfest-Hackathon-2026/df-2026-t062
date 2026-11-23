import { test, expect, openPlan } from './support/fixtures.ts'

test('未作成の用紙でも入力枠が原紙の座標に重なり、選択パネルを常設しない', async ({ page, ui }) => {
  await openPlan(page, ui)
  const flow = page.getByRole('region', { name: 'ケアプラン全用紙', exact: true })
  // 第6・7表には明細ページもある。用紙の種類数を総ページ数と混同しない。
  for (const number of [1, 2, 3, 4, 5, 6, 7]) {
    await expect(flow.locator(`[data-care-table="${number}"] .care-paper-page`).first()).toBeAttached()
  }
  await expect(flow.locator('.care-record-list')).toHaveCount(1) // 第7表の参照選択は今回の対象外
  await expect(flow.locator('.care-paper-operations')).toHaveCount(0)
  for (const table of [2, 3, 4, 5, 6]) {
    const paper = flow.locator(`[data-care-table="${table}"] .care-paper-page`).first()
    const field = paper.locator('.care-paper-field').first()
    await expect(field).toBeAttached()
    const geometry = await field.evaluate(el => {
      const parent = el.closest('.care-paper-page')!.getBoundingClientRect()
      const box = el.getBoundingClientRect(), style = getComputedStyle(el)
      const element = el as HTMLElement
      return { position: style.position, left: box.left - parent.left, top: box.top - parent.top,
        expectedLeft: parseFloat(element.style.left) / 100 * parent.width,
        expectedTop: parseFloat(element.style.top) / 100 * parent.height,
        width: box.width, expectedWidth: parseFloat(element.style.width) / 100 * parent.width,
        height: box.height, expectedHeight: parseFloat(element.style.height) / 100 * parent.height }
    })
    expect(geometry.position).toBe('absolute')
    for (const [actual, expected] of [[geometry.left, geometry.expectedLeft], [geometry.top, geometry.expectedTop], [geometry.width, geometry.expectedWidth], [geometry.height, geometry.expectedHeight]]) {
      expect(Math.abs(actual - expected)).toBeLessThan(1)
    }
  }
  const fourth = flow.locator('[data-care-table="4"]')
  await fourth.getByRole('button', { name: '記録を選ぶ', exact: true }).click()
  const records = page.getByRole('dialog', { name: '会議記録を選ぶ', exact: true })
  await expect(records.getByLabel('記録を検索')).toBeVisible()
  await records.getByRole('button', { name: '閉じる', exact: true }).click()
  const sixth = flow.locator('[data-care-table="6"]')
  await sixth.getByRole('button', { name: '対象月を選ぶ', exact: true }).click()
  const months = page.getByRole('dialog', { name: '第6表の対象月を選ぶ', exact: true })
  await expect(months.getByLabel('確定済み計画版')).toBeVisible()
  await months.press('Escape')
  await expect(months).not.toBeVisible()
  const third = flow.locator('.cp-plan-paper[data-care-table="3"]')
  await expect(third.getByRole('button', { name: '入力・修正', exact: true })).toBeDisabled()
  await third.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `/tmp/care-paper-layout-${ui}.png` })
})

test('空の第2・3・5・6表を全面から操作でき、表示だけでは記録を作らない', async ({ page, ui, clientId }) => {
  await openPlan(page, ui)
  const flow = page.getByRole('region', { name: 'ケアプラン全用紙', exact: true })
  const second = flow.locator('[data-care-table="2"]')
  await expect(second.locator('.care-paper-field').filter({ hasNotText: /.+/ })).toHaveCount(59)
  // 第2表: 5行×11列 + 氏名/作成日の4欄。最後の空欄からも作成へ進める。
  await second.getByRole('button', { name: 'サービス期間（入力・修正）', exact: true }).last().click()
  const create = page.getByRole('dialog', { name: '新しいケアプラン', exact: true })
  await expect(create).toBeVisible()
  await create.getByRole('button', { name: '閉じる', exact: true }).click()
  for (const number of [2, 3, 5, 6]) {
    const paper = flow.locator(`[data-care-table="${number}"] .care-paper-page`).first()
    await expect(paper).toBeAttached()
    await paper.screenshot({ path: `/tmp/care-paper-complete-${number}-${ui}.png` })
  }
  const third = flow.locator('[data-care-table="3"]')
  await expect(third.getByRole('button', { name: '週間枠（入力・修正）', exact: true })).toHaveCount(1)
  await expect(third.getByRole('button', { name: '日常生活活動（入力・修正）', exact: true })).toHaveCount(1)
  const sixth = flow.locator('[data-care-table="6"]')
  await expect(sixth.getByRole('button', { name: '時間帯（入力・修正）', exact: true })).toHaveCount(14)
  await sixth.getByRole('button', { name: '時間帯（入力・修正）', exact: true }).last().click()
  const months = page.getByRole('dialog', { name: '第6表の対象月を選ぶ', exact: true })
  await expect(months).toBeVisible()
  await months.getByRole('button', { name: '閉じる', exact: true }).click()
  const { headers } = await import('./support/fixtures.ts')
  const plans = await page.request.get(`/api/clients/${clientId}/care-plans`, { headers })
  expect((await plans.json()).plans).toEqual([])
  // 第5表の空の右欄からも入力を開始し、既存の保存経路に接続する。
  const fifth = flow.locator('[data-care-table="5"]')
  await fifth.getByRole('button', { name: '項目_右（入力・修正）', exact: true }).first().click()
  await expect(fifth.getByRole('textbox', { name: '記録内容', exact: true })).toBeVisible()
  await fifth.getByRole('textbox', { name: '記録内容', exact: true }).fill('空の枠から入力した架空の記録')
  const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/save'))
  await fifth.getByRole('button', { name: '記録を保存', exact: true }).click()
  expect((await saved).ok()).toBeTruthy()
  await page.reload()
  await openPlan(page, ui)
  await expect(flow.locator('[data-care-table="5"]').getByRole('textbox', { name: '記録内容', exact: true })).toHaveValue('空の枠から入力した架空の記録')
})
