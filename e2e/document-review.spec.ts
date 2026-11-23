import {test,expect,headers} from './support/fixtures.ts'
test('保存・人間の確認・正式確定を分け、古い画面からの確認を拒否する',async({page,request,clientId,ui},info)=>{
 test.skip(ui==='pad','PCの確認フロー。タブレットの操作確認は別途行う')
 const client=await (await request.get(`/api/clients/${clientId}`,{headers})).json()
 const id=client.client.documents.find((d:any)=>d.kind==='assessment').id
 const path=`/api/documents/${id}`
 expect((await request.post(path+'/save',{headers,data:{scope:'document'}})).status()).toBe(200)
 await page.getByRole('button',{name:'確認・確定',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'書類の確認と確定'})
 await expect(dialog).toContainText('未確認：2件')
 await expect(dialog.getByRole('button',{name:'正式版として確定',exact:true})).toBeDisabled()
 const doc=(await (await request.get(path,{headers})).json()).document
 expect((await request.patch(path+'/fields',{headers,data:{changes:[{key:'person.name',base:doc.fields['person.name'].value,value:'架空 確認変更'}]}})).status()).toBe(200)
 await dialog.getByRole('button',{name:'表示した内容を確認',exact:true}).click()
 await expect(dialog.getByRole('alert')).toContainText('内容または保存版が変わりました')
 await dialog.getByRole('button',{name:'閉じる',exact:true}).click()
 expect((await request.post(path+'/save',{headers,data:{scope:'document'}})).status()).toBe(200)
 await page.getByRole('button',{name:'確認・確定',exact:true}).click()
 await expect(dialog).toContainText('架空 確認変更')
 await dialog.getByRole('button',{name:'表示した内容を確認',exact:true}).click()
 await expect(dialog).toContainText('未確認：0件')
 await dialog.getByRole('button',{name:'正式版として確定',exact:true}).click()
 await expect(dialog).toContainText('正式版：第2版')
 await page.screenshot({path:info.outputPath('document-review.png')})
 await dialog.getByRole('button',{name:'閉じる',exact:true}).click()
 await page.reload()
 await expect(page.getByText('正式版 第2版',{exact:true})).toBeVisible()
})
