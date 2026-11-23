// 書類を作るときに AI が書く（#195）の仕事。worker の /tasks/document-fills/:id/run から呼ぶ。
//   3. 書く欄を決める（core/fill.ts の fillTargets）
//   4. 材料を集める: 元の書類の値を「欄の名前: 値」の文にし、値を入れた用紙の PDF をページごとの画像にする
//   5〜7. AI が書く・確かめる・最後の確かめ（./index.ts）
//   8. 書類に入れる: applyBatch（書き込みの記録は fill）。ケアマネが書いた・直した欄は書き換えない
// ログには中身（書類の値・AI の答え）を出さない。出すのは id・状態・時間・使った量・数だけ。
import { randomUUID } from 'node:crypto'
import { fieldDict } from '../../core/dictionary.ts'
import { fillTargets } from '../../core/fill.ts'
import { formText } from '../../core/form-text.ts'
import * as fills from '../../db/document-fills.ts'
import { loadFormDef, loadVersion } from '../../db/forms.ts'
import { tx } from '../../db/pool.ts'
import { applyBatch, readFields } from '../../db/repo.ts'
import { contextFields, type WorkerContext, type WorkerDeps } from '../jobs.ts'
import type { Part } from '../vertex/gemini.ts'
import { fillDocument } from './index.ts'

const log = (rec: Record<string, unknown>, context?: WorkerContext) => console.log(JSON.stringify({ severity: 'INFO', ...contextFields(context), ...rec }))

class LeaseLost extends Error { constructor() { super('document fill lease lost') } }

/** 元の書類のページの画像の解像度（どの見出しの下・表のどの行の値かが読めれば足りる） */
const PAGE_DPI = 110

/** 元の書類の値を入れた用紙の、ページごとの画像。様式の元の PDF が置き場にないときなどは画像なし（文だけで書く） */
async function sourceImages(deps: WorkerDeps, versionId: string, values: Record<string, unknown>, context?: WorkerContext): Promise<Part[]> {
  try {
    const db = await deps.db()
    const [{ makePdf }, { openPdf }] = await Promise.all([import('../../api/pdf.ts'), import('../form-import/pdf.ts')])
    const pdf = await openPdf(await makePdf(deps.storage(), await loadVersion(db, versionId), values))
    try {
      const parts: Part[] = []
      for (let page = 1; page <= pdf.numPages; page++) parts.push({ text: `${page} ページ目の画像` }, { png: await pdf.png(page, PAGE_DPI) })
      return parts
    } finally { await pdf.close() }
  } catch (e) {
    log({ msg: 'document fill: source images unavailable', error: (e as Error)?.name ?? 'Error' }, context)
    return []
  }
}

export async function runDocumentFill(deps: WorkerDeps, id: string, context?: WorkerContext): Promise<void> {
  const db = await deps.db()
  const token = randomUUID()
  const claimed = await fills.claimFill(db, id, token)
  if (!claimed) return log({ msg: 'document fill already taken or done', fillId: id }, context)
  const heartbeat = setInterval(() => {
    void fills.touchFill(db, id, token).catch((e) => log({ msg: 'document fill lease heartbeat failed', fillId: id, error: (e as Error).name }, context))
  }, 60_000)
  heartbeat.unref()
  const t0 = Date.now()
  try {
    const providers = await deps.providers()
    if (!providers.documentFill) throw new Error('書類を書く AI がありません')

    // 3. 書く欄を決める
    const docs = (await db.query(
      `SELECT d.id, d.template_version_id, k.name AS kind_name FROM documents d JOIN form_kinds k ON k.key = d.kind
       WHERE d.id = ANY($1) AND d.office_id = $2`,
      [[claimed.documentId, claimed.sourceDocumentId], claimed.officeId],
    )).rows
    const target = docs.find((d) => d.id === claimed.documentId)
    const source = docs.find((d) => d.id === claimed.sourceDocumentId)
    if (!target || !source) throw Object.assign(new Error('document missing'), { name: 'DocumentMissing' })
    const form = await loadFormDef(db, target.template_version_id)
    const fields = await readFields(db, target.id)
    const values = Object.fromEntries(Object.entries(fields).filter(([, f]) => f.value !== null).map(([k, f]) => [k, f.value]))
    // 写した値: 作ったときの写し（copy）で入り、まだ AI の値のままの欄
    const copyBatch = (await db.query("SELECT changes FROM batches WHERE document_id = $1 AND kind = 'copy' ORDER BY created_at LIMIT 1", [target.id])).rows[0]
    const copied = new Set<string>(((copyBatch?.changes ?? []) as { key: string }[]).map((c) => c.key).filter((k) => fields[k]?.by === 'ai'))
    const targets = fillTargets(form, Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, { value: f.value, by: f.by }])), copied)

    // 4. 材料を集める
    const sourceForm = await loadFormDef(db, source.template_version_id)
    const sourceValues = Object.fromEntries((await db.query('SELECT key, value FROM field_values WHERE document_id = $1 AND value IS NOT NULL', [source.id])).rows.map((r) => [r.key, r.value]))
    const text = formText(fieldDict(sourceForm.localFields), sourceForm.keys, sourceValues)
    const images = await sourceImages(deps, source.template_version_id, sourceValues, context)

    // 5〜7. AI が書く
    const r = await fillDocument({
      source: { kindName: source.kind_name, text, images },
      target: { kindName: target.kind_name, form, values, targets },
      llm: providers.documentFill(),
      onStep: async (step) => { if (!await fills.touchFill(db, id, token, step)) throw new LeaseLost() },
    })

    // 8. 書類に入れる（印がまだ自分のものなら）
    const status = r.partial ? 'partial' : 'succeeded'
    const steps = {
      collect: { targets: targets.length, images: images.filter((p) => 'png' in p).length },
      write: r.steps,
      ai: { calls: r.usage.calls, promptTokens: r.usage.promptTokens, cachedTokens: r.usage.cachedTokens, outputTokens: r.usage.outputTokens, thinkingTokens: r.usage.thinkingTokens, yen: r.usage.yen },
      totalSeconds: (Date.now() - t0) / 1000,
    }
    const ok = await tx(db, async (c) => {
      if (!await fills.lockFill(c, id, token)) return false
      const applied = await applyBatch(db, {
        officeId: claimed.officeId, documentId: target.id, kind: 'fill', label: `AI 書き込み・${source.kind_name}を元に書いた`, proposed: r.proposed,
      }, (fn) => fn(c))
      return fills.finishFill(c, id, token, status, applied.batchId, { ...steps, apply: { changes: applied.plan.changes.length, kept: applied.plan.kept.length } })
    })
    if (!ok) throw new LeaseLost()
    log({ msg: 'document fill done', fillId: id, status, seconds: steps.totalSeconds, targets: targets.length, written: Object.keys(r.proposed).length, calls: r.usage.calls, yen: r.usage.yen }, context)
  } catch (e) {
    if (e instanceof LeaseLost) return log({ msg: 'document fill lease lost', fillId: id }, context)
    const kind = (e as Error)?.name ?? 'Error'
    await fills.releaseFill(db, id, token, claimed.attempts >= fills.MAX_FILL_ATTEMPTS, kind)
    console.error(JSON.stringify({ severity: 'ERROR', ...contextFields(context), msg: 'document fill failed', fillId: id, error: kind }))
    // 中身が入りうるので、ローカルで調べるときだけ出す
    if (process.env.DEBUG_JOBS) console.error(e)
    throw e
  } finally {
    clearInterval(heartbeat)
  }
}

/** 見回り: 積み損ね・止まった仕事を積み直す。積み直した数 */
export async function reconcileDocumentFills(deps: WorkerDeps, enqueue: (id: string) => Promise<void>): Promise<number> {
  const ids = await fills.fillsToRequeue(await deps.db())
  for (const id of ids) await enqueue(id)
  return ids.length
}
