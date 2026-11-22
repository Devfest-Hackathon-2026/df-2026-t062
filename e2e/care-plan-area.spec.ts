import { test, expect, createPlan, openCareDocument, openPlan, headers } from './support/fixtures.ts'

test('中央のスクロールだけで第1〜7表へ移動し、左の選択と未保存入力を保つ',async({page,ui})=>{
 await createPlan(page,ui)
 const policy=page.getByRole('textbox',{name:'総合的援助方針',exact:true})
 await policy.fill('スクロール後も保持する未保存の方針');await policy.blur()
 const container=page.getByRole('region',{name:'ケアプラン全用紙',exact:true})
 await expect(container.locator('[data-care-table]')).toHaveCount(7)
 await expect.poll(()=>container.getByRole('img').count()).toBeGreaterThanOrEqual(7)
 const nav=page.getByRole('tablist',{name:'ケアプランの書類',exact:true})
 await container.dispatchEvent('wheel')
 await container.evaluate(e=>{e.scrollTop=e.scrollHeight})
 await expect(nav.getByRole('tab',{name:'第7表 利用票別表',exact:true})).toHaveAttribute('aria-selected','true')
 await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBe(0)
 await expect(nav).toBeInViewport()
 await container.dispatchEvent('wheel')
 await container.evaluate(e=>{e.scrollTop=0})
 await expect(nav.getByRole('tab',{name:'第1表 基本情報と方針',exact:true})).toHaveAttribute('aria-selected','true')
 await expect(policy).toHaveValue('スクロール後も保持する未保存の方針')
 await nav.getByRole('tab',{name:'第6表 サービス利用票',exact:true}).click()
 await expect(container.locator('[data-care-table="6"]')).toBeInViewport()
 await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBe(0)
})

test('ケアプランを開くと左の縦一覧から全7表の空用紙を閲覧でき、記録は作成しない',async({page,ui,clientId})=>{
 const writes:string[]=[]
 page.on('request',r=>{if(r.method()==='POST'&&/care-(plans|records|plan-months)/.test(r.url()))writes.push(r.url())})
 await openPlan(page,ui)
 const nav=page.getByRole('tablist',{name:'ケアプランの書類',exact:true})
 await expect(nav.getByRole('tab')).toHaveCount(7)
 let bottom=0
 for(let n=1;n<=7;n++){
  const tab=nav.getByRole('tab',{name:new RegExp(`^第${n}表 `)})
  const box=(await tab.boundingBox())!;expect(box.y).toBeGreaterThanOrEqual(bottom);bottom=box.y+box.height
  await tab.click()
  await expect(page.getByRole('img',{name:new RegExp(`第${n}表.*原紙`)}).first()).toBeVisible()
 }
 expect(writes).toEqual([])
 for(const endpoint of ['care-plans','care-records?kind=care_plan_4','care-records?kind=care_plan_5','care-plan-months','care-plan-fees']){
  const r=await page.request.get(`/api/clients/${clientId}/${endpoint}`,{headers});expect(r.ok()).toBeTruthy()
  const body=await r.json();expect(body.plans??body.records??body.months??body.fees).toHaveLength(0)
 }
})

test('第4〜7表の入口をケアプラン内に集約し、表の往復で未保存入力を保持する', async ({ page, ui }) => {
  if (ui === 'pc') {
    const documents = page.getByRole('tablist', { name: '書類', exact: true })
    await expect(documents.getByRole('tab', { name: /第[4-7]表/ })).toHaveCount(0)
    await page.getByRole('button', { name: '＋ 書類を作る', exact: true }).click()
  } else await page.getByRole('button', { name: 'アセスメント', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /第[4-7]表/ })).toHaveCount(0)
  if (ui === 'pc') await page.getByRole('button', { name: '＋ 書類を作る', exact: true }).click()
  else await page.getByRole('button', { name: 'アセスメント', exact: true }).click()
  await createPlan(page, ui)
  const policy = page.getByRole('textbox', { name: '総合的援助方針', exact: true })
  await policy.fill('表の切り替え後も残す未保存の方針')
  await policy.blur()
  await openCareDocument(page, ui, 4)
  await page.getByRole('button', { name: '＋ 会議記録を追加', exact: true }).click()
  await page.locator('.cp-area-panel[data-active=true]').getByRole('button', { name: '入力・修正', exact: true }).click()
  await page.getByLabel('検討内容', { exact: true }).fill('切り替えで失わない会議の未保存入力')
  await page.getByRole('button', { name: '用紙に戻る', exact: true }).click()
  await openCareDocument(page, ui, 5)
  await expect(page.getByRole('heading', { name: /さんの支援経過/ })).toBeVisible()
  await openCareDocument(page, ui, 6)
  await expect(page.getByRole('heading', { name: /さんのサービス利用票$/ })).toBeVisible()
  await openCareDocument(page, ui, 7)
  await expect(page.getByRole('heading', { name: /さんのサービス利用票別表/ })).toBeVisible()
  await openCareDocument(page, ui, 4)
  await page.locator('.cp-area-panel[data-active=true]').getByRole('button', { name: '入力・修正', exact: true }).click()
  await expect(page.getByLabel('検討内容', { exact: true })).toHaveValue('切り替えで失わない会議の未保存入力')
  await page.getByRole('button', { name: '用紙に戻る', exact: true }).click()
  await page.getByRole('tablist', { name: 'ケアプランの書類', exact: true }).getByRole('tab', { name: '第1表 基本情報と方針', exact: true }).click()
  await expect(policy).toHaveValue('表の切り替え後も残す未保存の方針')
})
