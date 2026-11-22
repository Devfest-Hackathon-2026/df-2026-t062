// 上げた PDF から様式の下書きを作るジョブ（#103）。worker の /tasks/form-imports/:id/run から呼ぶ。
//   1. 期限つきの印を付ける（同じ取り込みが 2 回届いても、2 つ目は何もしない）
//   2. 上げたままの PDF（imports/<id>.pdf）を読み、変換する（importPdf。#99）
//   3. matched・failed はそのまま終える。succeeded なら、元の PDF とページの画像を様式の場所（pdf/<sha256>/）に置いてから、下書きの版を作る
//   4. 済んだら上げたままの PDF を消す（失敗したものは見回りが 7 日後に消す）
// ログには中身（用紙の文字・AI の答え）を出さない。出すのは id・状態・時間・使った量・要確認の数だけ。
import { randomUUID } from 'node:crypto'
import type { Storage } from '../../api/storage.ts'
import { basePdfAssetPath, importPdfPath, pageImageAssetPath, type FormPage } from '../../core/form.ts'
import * as imports from '../../db/form-imports.ts'
import { contextFields, type WorkerContext, type WorkerDeps } from '../jobs.ts'
import { importPdf, type ImportLimits } from './index.ts'
import { openPdf } from './pdf.ts'

/** ページの画像の解像度（forms:assets と同じ） */
const PAGE_DPI = 180
/** 画像は 1 日ブラウザが覚えてよい（期限つきの URL も 1 日の区切りで同じ） */
const IMAGE_CACHE = 'private, max-age=86400'

const log = (rec: Record<string, unknown>, context?: WorkerContext) => console.log(JSON.stringify({ severity: 'INFO', ...contextFields(context), ...rec }))

class LeaseLost extends Error { constructor() { super('form import lease lost') } }

/** 元の PDF とページの画像を、様式の場所に置く（場所は中身のハッシュで決まるので、同じ PDF なら same） */
async function putAssets(storage: Storage, officeId: string | null, sha256: string, data: Uint8Array, pages: FormPage[]) {
  await storage.writeOnce('forms', basePdfAssetPath(sha256, officeId), data, 'application/pdf')
  const pdf = await openPdf(data)
  try {
    for (const p of pages) {
      const png = new Uint8Array(await pdf.png(p.pdfIndex + 1, PAGE_DPI))
      await storage.writeOnce('forms', pageImageAssetPath(sha256, p.pdfIndex + 1, officeId), png, 'image/png', IMAGE_CACHE)
    }
  } finally {
    await pdf.close()
  }
}

/** 上げたままの PDF を消す。消せなくても、見回りがあとで消す */
export async function removeUpload(deps: Pick<WorkerDeps, 'db' | 'storage'>, id: string, officeId: string | null): Promise<void> {
  await deps.storage().remove('forms', importPdfPath(id, officeId))
  await imports.markUploadDeleted(await deps.db(), id)
}

export async function runFormImport(deps: WorkerDeps, importId: string, opts: { limits?: ImportLimits } = {}, context?: WorkerContext): Promise<void> {
  const db = await deps.db()
  const token = randomUUID()
  const claimed = await imports.claimImport(db, importId, token)
  if (!claimed) return log({ msg: 'form import already taken or done', importId }, context)
  // 長い変換（AI を何回も呼ぶ）の間も印の期限を延ばす。古い実行の書き込みは token で断る
  const heartbeat = setInterval(() => {
    void imports.extendImportLease(db, importId, token).catch((e) => log({ msg: 'form import lease heartbeat failed', importId, error: (e as Error).name }, context))
  }, 60_000)
  heartbeat.unref()
  const t0 = Date.now()
  try {
    const storage = deps.storage()
    const data = await storage.read('forms', importPdfPath(importId, claimed.officeId))
    const known = await imports.knownGlobalPdfs(db)
    const llm = (await deps.providers()).formImport()
    const r = await importPdf(data, { ask: llm.ask, knownSha256: new Set(known.keys()), limits: opts.limits })
    let review = 0
    if (r.status === 'matched') {
      const hits = known.get(r.basePdfSha256)!
      const v = hits.find((h) => h.kind === claimed.kind) ?? hits[0]
      if (!await imports.finishImport(db, importId, token, { status: 'matched', basePdfSha256: r.basePdfSha256, versionId: v.versionId })) throw new LeaseLost()
    } else if (r.status === 'failed') {
      if (!await imports.finishImport(db, importId, token, { status: 'failed', basePdfSha256: r.basePdfSha256, errorKind: r.errorKind })) throw new LeaseLost()
    } else {
      // 版を作る前に置く（版ができたら、画面がすぐ画像を読む）
      await putAssets(storage, claimed.officeId, r.basePdfSha256, data, r.draft.pages)
      if (!await imports.finishWithDraft(db, claimed, token, r.basePdfSha256, r.draft)) throw new LeaseLost()
      review = r.draft.review.length
    }
    const usage = llm.usage()
    log({ msg: 'form import done', importId, status: r.status, seconds: (Date.now() - t0) / 1000, calls: usage.calls, yen: usage.yen, review })
    if (r.status !== 'failed') {
      await removeUpload(deps, importId, claimed.officeId).catch((e) => log({ msg: 'form import upload not removed', importId, error: (e as Error).name }))
    }
  } catch (e) {
    if (e instanceof LeaseLost) return log({ msg: 'form import lease lost', importId }, context)
    const kind = (e as Error)?.name ?? 'Error'
    await imports.releaseImport(db, importId, token, claimed.attempts >= imports.MAX_IMPORT_ATTEMPTS)
    console.error(JSON.stringify({ severity: 'ERROR', ...contextFields(context), msg: 'form import failed', importId, error: kind }))
    // 中身が入りうるので、ローカルで調べるときだけ出す
    if (process.env.DEBUG_JOBS) console.error(e)
    throw e
  } finally {
    clearInterval(heartbeat)
  }
}

/** 見回り: 止まった取り込みを積み直し、消し残した上げたままの PDF を消す。積み直した数 */
export async function reconcileFormImports(deps: WorkerDeps, enqueue: (importId: string) => Promise<void>): Promise<number> {
  const db = await deps.db()
  const ids = await imports.importsToRequeue(db)
  for (const id of ids) await enqueue(id)
  for (const u of await imports.uploadsToDelete(db)) {
    await removeUpload(deps, u.id, u.officeId).catch((e) => log({ msg: 'form import upload not removed', importId: u.id, error: (e as Error).name }))
  }
  return ids.length
}
