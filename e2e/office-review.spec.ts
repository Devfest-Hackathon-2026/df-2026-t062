import {test,expect} from '@playwright/test'
const headers={Authorization:'Bearer dev:e2e-office@example.com'}
test('文字・丸・図の位置を直し、保存後と再表示で対応が変わらない',async({page,request},info)=>{
 test.skip(info.project.name.startsWith('ipad-'),'責任者の書式設定はPC用')
 const kinds=await (await request.get('/api/office/forms',{headers})).json()
 const id=kinds.kinds.find((k:any)=>k.key==='assessment').draft.versionId
 const path=`/api/office/form-versions/${id}`
 const before=await (await request.get(path,{headers})).json()
 const form=before.formVersion
 const choices=['text','circleMark','image'].map(type=>{
  for(const p of form.pages){const slot=form.schemas[p.pdfIndex].find((s:any)=>s.type===type);if(slot)return {slot,page:p}}
  throw new Error(`テスト用の${type}欄がない`)
 })
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
 await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//,r=>r.abort())
 await page.route('**/__/firebase/init.json',r=>r.fulfill({status:404,body:''}))
 await page.goto('/')
 await page.getByRole('textbox',{name:'メールアドレス'}).fill('e2e-office@example.com')
 await page.getByRole('button',{name:'ログイン',exact:true}).click()
 await expect(page.getByRole('button',{name:'ログイン',exact:true})).not.toBeVisible()
 const review=`/office/forms/assessment/review/${id}?fix=1`
 await page.goto(review)
 for(const {slot,page:p} of choices){
  await page.getByRole('navigation',{name:'ページ'}).getByRole('button',{name:new RegExp(`^${p.no} ページ`)}).click()
  const box=page.locator(`[data-slot="${slot.name}"]`)
  await box.click()
  const dialog=page.getByRole('dialog',{name:'この欄に入るもの'})
  await dialog.getByRole('spinbutton',{name:'左から（mm）'}).fill('999')
  await dialog.getByRole('button',{name:'位置を保存',exact:true}).click()
  await expect(dialog.getByRole('alert')).toContainText('用紙の外')
  const x=Math.round((slot.position.x+1)*10)/10
  await dialog.getByRole('spinbutton',{name:'左から（mm）'}).fill(String(x))
  const saved=page.waitForResponse(r=>r.url().endsWith(path)&&r.request().method()==='PATCH')
  await dialog.getByRole('button',{name:'位置を保存',exact:true}).click()
  expect((await saved).status()).toBe(200)
  await expect(dialog.getByRole('spinbutton',{name:'左から（mm）'})).toHaveValue(String(x))
  if(slot.type==='circleMark')await page.screenshot({path:info.outputPath('position-editor.png'),fullPage:true})
 }
 await page.reload()
 await expect(page.getByRole('button',{name:'直した書式を使い始める',exact:true})).toBeEnabled()
 const after=await (await request.get(path,{headers})).json()
 expect(after.formVersion.bindings).toEqual(form.bindings)
 expect(after.formVersion.localFields).toEqual(form.localFields)
 for(const {slot,page:p} of choices)expect(after.formVersion.schemas[p.pdfIndex].find((s:any)=>s.name===slot.name).position.x).toBe(Math.round((slot.position.x+1)*10)/10)
 expect(errors).toEqual([])
})
