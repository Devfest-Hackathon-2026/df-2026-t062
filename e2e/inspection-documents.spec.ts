import {test,expect,headers,createPlan,addNeed,table,openCareDocument,getPlan} from './support/fixtures.ts'
import {writeFile} from 'node:fs/promises'
import type {Page} from '@playwright/test'
async function panel(page:Page,ui:'pc'|'pad'){
 if(ui==='pad'){
  await page.locator('.cp-touch-inspection').getByRole('button',{name:'点検する',exact:true}).click()
  return page.getByRole('dialog',{name:'書類の点検',exact:true})
 }
 const assistant=page.locator('.assistant-panel')
 const menu=assistant.getByRole('button',{name:/^点検する/})
 if(await menu.isVisible())await menu.click()
 return assistant.locator('.insp')
}
test('今開いている第2表の未保存入力を点検し、同じ用紙へ戻る。第1表と履歴を混ぜない',async({page,clientId,ui},info)=>{
 await createPlan(page,ui);await addNeed(page)
 const before=await getPlan(page,clientId),doc2=before.documents.find(d=>d.formNo===2)!
 await page.locator('section[data-care-table="2"]').getByRole('textbox',{name:'長期目標',exact:true}).fill('点検前の架空の未保存変更')
 const inspector=await panel(page,ui)
 await expect(inspector.locator('.insp-document-scope')).toContainText('第2表')
 const started=page.waitForRequest(r=>r.url().endsWith(`/api/clients/${clientId}/inspections`)&&r.method()==='POST')
 await inspector.getByRole('button',{name:'点検を始める',exact:true}).click()
 expect((await started).postDataJSON().documentId).toBe(doc2.documentId)
 await expect(inspector.locator('.insp-scope-count')).toContainText('対象 9項目 ／ 判定済み 9項目')
 await expect(inspector.locator('.insp-uninspected summary')).toContainText('53項目')
 const now=await getPlan(page,clientId)
 expect(now.needs[0].longGoal.goal).toBe('点検前の架空の未保存変更')
 expect(now.documents.find(d=>d.formNo===2)!.latestRevision).toBe(doc2.latestRevision)
 await page.screenshot({path:info.outputPath('inspection-plan2.png')})
 await inspector.locator('.insp-ck-ng').filter({hasText:'アセスメントで抽出した課題に基づくニーズの記載'}).click()
 const dialog=page.getByRole('dialog',{name:'第2表・ニーズの追加と選択',exact:true})
 await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'閉じる',exact:true}).click()
 await table(page,1)
 const first=await panel(page,ui)
 await expect(first.locator('.insp-document-scope')).toContainText('第1表')
 await expect(first.getByRole('button',{name:'点検を始める',exact:true})).toBeEnabled()
 await first.getByRole('button',{name:'点検を始める',exact:true}).click()
 await expect(first.locator('.insp-scope-count')).toContainText('対象 2項目 ／ 判定済み 2項目')
})

test('複数の支援経過から開いた古い記録を点検し、本文の入力欄へ戻る',async({page,request,clientId,ui})=>{
 const ids:string[]=[]
 for(const content of ['架空の古い記録A','架空の新しい記録B']){
  const res=await request.post(`/api/clients/${clientId}/care-records`,{headers,data:{kind:'care_plan_5',requestId:crypto.randomUUID()}})
  expect(res.status()).toBe(201)
  const id=(await res.json()).id;ids.push(id)
  expect((await request.patch(`/api/documents/${id}/fields`,{headers,data:{changes:[{key:'progress.content',base:null,value:content}]}})).status()).toBe(200)
  expect((await request.post(`/api/documents/${id}/save`,{headers,data:{scope:'document'}})).status()).toBe(200)
 }
 await openCareDocument(page,ui,5)
 const paper=page.locator('[data-care-table="5"]')
 await paper.getByRole('button',{name:'記録を選ぶ',exact:true}).click()
 await page.getByRole('dialog',{name:'支援経過を選ぶ',exact:true}).getByRole('button',{name:/架空の古い記録A/}).click()
 await expect(paper.getByRole('textbox',{name:'記録内容',exact:true})).toHaveValue('架空の古い記録A')
 const inspector=await panel(page,ui)
 await expect(inspector.locator('.insp-document-scope')).toContainText('第5表')
 const started=page.waitForRequest(r=>r.url().endsWith(`/api/clients/${clientId}/inspections`)&&r.method()==='POST')
 await inspector.getByRole('button',{name:'点検を始める',exact:true}).click()
 expect((await started).postDataJSON().documentId).toBe(ids[0])
 await expect(inspector.locator('.insp-scope-count')).toContainText('対象 6項目 ／ 判定済み 6項目')
 await inspector.locator('.insp-ck-ng').filter({hasText:'本人の心身状態に関する変化の医療者への報告'}).click()
 await expect(paper.getByRole('textbox',{name:'記録内容',exact:true})).toBeFocused()
})

test('モニタリングを作成・保存・再表示・PDF出力し、58〜60番の3項目を点検できる',async({page,request,clientId,ui},info)=>{
 const created=page.waitForResponse(r=>r.url().endsWith(`/api/clients/${clientId}/documents`)&&r.request().method()==='POST')
 if(ui==='pc'){
  await page.getByRole('button',{name:'＋ 書類を作る',exact:true}).click()
  await page.getByRole('menuitem',{name:'モニタリング記録',exact:true}).click()
 }else{
  await page.locator('.pad>header').getByRole('button',{name:'アセスメント',exact:true}).click()
  await page.getByRole('menuitem',{name:'＋ モニタリング記録',exact:true}).click()
 }
 const id=(await (await created).json()).id
 if(ui==='pc')await page.getByRole('dialog',{name:'アセスメントから、AI が書きましょうか？',exact:true}).getByRole('button',{name:'自分で書く',exact:true}).click()
 const goal=page.getByRole('textbox',{name:/^目標の達成状況・生活上の課題/})
 await expect(goal).toBeVisible()
 await goal.fill('架空の目標について、前回からの生活状況を確認しました。')
 await goal.blur()
 const saved=page.waitForResponse(r=>r.url().endsWith(`/api/documents/${id}/save`)&&r.request().method()==='POST')
 await page.getByRole('button',{name:'書類を保存',exact:true}).first().click()
 expect((await saved).status()).toBe(200)
 await page.reload()
 if(ui==='pc')await page.getByRole('tab',{name:'モニタリング記録',exact:true}).click()
 else{
  await page.locator('.pad>header').getByRole('button',{name:'アセスメント',exact:true}).click()
  await page.getByRole('menuitem',{name:'モニタリング記録',exact:true}).click()
 }
 await expect(goal).toHaveValue('架空の目標について、前回からの生活状況を確認しました。')
 const pdf=await request.get(`/api/documents/${id}/pdf`,{headers})
 await writeFile(info.outputPath('monitoring-filled.pdf'),await pdf.body())
 expect(pdf.status()).toBe(200);expect((await pdf.body()).subarray(0,4).toString()).toBe('%PDF')
 let inspector
 if(ui==='pc')inspector=await panel(page,ui)
 else{
  await page.locator('.pad>header').getByRole('button',{name:'点検する',exact:true}).click()
  inspector=page.getByRole('dialog',{name:'書類の点検',exact:true})
 }
 await expect(inspector.locator('.insp-document-scope')).toContainText('モニタリング')
 await inspector.getByRole('button',{name:'点検を始める',exact:true}).click()
 await expect(inspector.locator('.insp-scope-count')).toContainText('対象 3項目 ／ 判定済み 3項目')
 await page.screenshot({path:info.outputPath('inspection-monitoring.png')})
 await inspector.locator('.insp-ck-ng').filter({hasText:'本人の心身状態に関する変化の医療者への報告'}).click()
 await expect(page.getByRole('textbox',{name:/^医療者への報告・連携の内容/})).toBeFocused()
})
