// UI確認用の架空事業所。通常のケアプランE2Eとは別事業所に分離する。
import type { Db } from '../../db/pool.ts'
import type { Storage } from '../../api/storage.ts'
import { seed } from '../../db/seed.ts'
import { loadVersion, publishedVersionId, registerVersion } from '../../db/forms.ts'
import { basePdfAssetPath, pageImageAssetPath } from '../../core/form.ts'
export async function seedOfficeReview(db:Db,storage:Storage) {
 const {officeId}=await seed(db,{email:'e2e-office@example.com',officeName:'E2E書式確認事業所'})
 await db.query("UPDATE staff SET role='admin' WHERE office_id=$1",[officeId])
 const v=await loadVersion(db,await publishedVersionId(db,officeId,'assessment'))
 await registerVersion(db,{...v,officeId,title:'架空の書式確認用'})
 const sha=v.basePdfSha256
 await storage.writeOnce('forms',basePdfAssetPath(sha,officeId),await storage.read('forms',basePdfAssetPath(sha)),'application/pdf')
 for(const p of v.pages)await storage.writeOnce('forms',pageImageAssetPath(sha,p.pdfIndex+1,officeId),await storage.read('forms',pageImageAssetPath(sha,p.pdfIndex+1)),'image/png')
}
