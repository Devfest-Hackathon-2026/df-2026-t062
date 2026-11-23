import { test, expect } from '@playwright/test'

test('家族図の人物選択と家屋図の壁・家具を同じ編集画面で反映できる', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/diagram-editor-integration', route => route.fulfill({ contentType: 'text/html', body:
    '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>t=>t; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/test/fixtures/diagram-editor-integration.tsx"></script></body></html>' }))
  await page.goto('/diagram-editor-integration')
  await page.getByRole('button', { name: '家族図を開く', exact: true }).click()
  await page.locator('.diagram-canvas [data-person-id="subject"]').click()
  await expect(page.getByLabel('名前', { exact: true })).toHaveValue('架空本人')
  await page.getByRole('combobox', { name: '生死', exact: true }).selectOption('alive')
  await page.getByRole('button', { name: '確認へ進む', exact: true }).click()
  await page.getByRole('button', { name: '用紙に反映', exact: true }).click()
  let value = JSON.parse(await page.getByLabel('反映した図').innerText())
  expect(value.data.people[0].deceased).toBe(false)
  await page.getByRole('button', { name: '家屋図を開く', exact: true }).click()
  await page.getByRole('button', { name: '壁', exact: true }).click()
  const svg = page.locator('.diagram-canvas svg').first()
  for (const x of [100, 300]) {
    const point = await svg.evaluate((element, x) => { const p = new DOMPoint(x, 100).matrixTransform((element as SVGSVGElement).getScreenCTM()!); return { x: p.x, y: p.y } }, x)
    await page.mouse.click(point.x, point.y)
  }
  await expect(page.locator('[data-line-endpoint="end"]')).toBeVisible()
  await page.getByRole('button', { name: '便器', exact: true }).click()
  await page.getByRole('button', { name: '確認へ進む', exact: true }).click()
  await page.getByRole('button', { name: '用紙に反映', exact: true }).click()
  value = JSON.parse(await page.getByLabel('反映した図').innerText())
  expect(value.data.items.some((item: { kind: string, wallLine?: boolean }) => item.kind === 'wall' && item.wallLine)).toBe(true)
  expect(value.data.items.some((item: { kind: string }) => item.kind === 'toilet')).toBe(true)
  expect(errors).toEqual([])
})
