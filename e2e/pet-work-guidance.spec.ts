import { test, expect, headers } from './support/fixtures.ts'

test('猫と取込メニューが同じ読取状況と候補を表示する', async ({ page, ui }) => {
  test.skip(ui !== 'pc', '猫の業務案内はPC用')
  let reads = 0
  await page.route('**/api/documents/*/inputs', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    reads++
    await route.fulfill({ json: { inputs: [{
      id: 'mock-input', fileName: '架空の資料.pdf', mime: 'application/pdf', sha256: 'a'.repeat(64),
      status: reads === 1 ? 'processing' : 'review', errorKind: null, createdAt: '2026-11-23T00:00:00Z', adopted: [], adoptedValues: {},
      result: reads === 1 ? null : {
        candidates: [{ key: 'complaint.person', value: '架空の候補', base: null, cite: ['e1'] }],
        evidence: [{ id: 'e1', page: 1, text: '架空の原文', recordedOn: '2026-11-01', region: null, uncertain: false }],
        issues: [], incompleteFields: [],
      },
    }] } })
  })
  await page.reload()
  const pet = page.locator('.assistant-panel')
  await expect(pet).toContainText('書類を読み取っています。用紙の作業を続けられます。')
  await expect(pet.getByRole('button', { name: /^書類を取り込む/ })).toContainText('読み取り中')
  await expect(pet).toContainText('取り込んだ書類に確認できる項目が1件あります。')
  await expect(pet.getByRole('button', { name: /^書類を取り込む/ })).toContainText('確認待ち 1件')
  await pet.getByRole('button', { name: /^書類を取り込む/ }).click()
  await expect(pet).toContainText('架空の資料.pdf')
  await expect(pet).toContainText('架空の候補')
  await expect(pet.getByRole('checkbox', { name: /を反映$/ })).toHaveCount(1)
})

test('未解決の入力競合を猫が案内し、保存を送信しない', async ({ page, ui, clientId }) => {
  test.skip(ui !== 'pc', '猫の業務案内はPC用')
  const client = (await (await page.request.get(`/api/clients/${clientId}`, { headers })).json()).client
  const id = client.documents.find((document: { kind: string }) => document.kind === 'assessment').id
  let rejected = false
  let saves = 0
  await page.route(`**/api/documents/${id}`, async route => {
    const response = await route.fetch()
    const body = await response.json()
    body.document.fields['complaint.person'] = { value: rejected ? '別の画面の値' : 'AIの元案', by: 'ai', aiValue: 'AIの元案' }
    await route.fulfill({ response, json: body })
  })
  await page.route(`**/api/documents/${id}/fields`, async route => {
    rejected = true
    await route.fulfill({ status: 409, json: { error: 'conflict', message: '検証用の入力競合' } })
  })
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/documents/${id}/save`) saves++ })
  await page.reload()
  await page.getByRole('textbox', { name: /^相談内容 本人/ }).fill('保持する手入力')
  const conflicts = page.getByRole('region', { name: '入力の競合', exact: true })
  await expect(conflicts).toContainText('保持する手入力')
  await expect(page.locator('.assistant-panel')).toContainText('入力が重なった項目があります。用紙の表示を見比べてください。')
  await page.getByRole('button', { name: '書類を保存', exact: true }).click()
  await expect(conflicts).toContainText('保持する手入力')
  expect(saves).toBe(0)
  await conflicts.getByRole('button', { name: /の入力を破棄$/ }).click()
  await expect(conflicts).not.toBeVisible()
  await expect(page.locator('.assistant-panel')).not.toContainText('入力が重なった項目があります。')
})
