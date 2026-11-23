import { test, expect, openPlan } from './support/fixtures.ts'

test('未作成の用紙でも入力枠が原紙の座標に重なり、選択パネルを常設しない', async ({ page, ui }) => {
  await openPlan(page, ui)
  const flow = page.getByRole('region', { name: 'ケアプラン全用紙', exact: true })
  await expect(flow.locator('.care-paper-page')).toHaveCount(7)
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
