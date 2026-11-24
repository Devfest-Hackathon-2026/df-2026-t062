// AI 点検のジョブ（#113）。worker の /tasks/inspections/:id/run から呼ぶ。docs/再設計/16_書類と点検の基盤.md の「流れ」。
//   1. 集める: 指定された書類と参考資料の今の値。録音は読まない。読んだ値の指紋を残す
//   2・3. プログラムと AI で判定（./index.ts）
//   4. 残す: 項目ごとの結果と、押したときに移る欄
// 点検は値を変えない。ログには中身（書類の値・AI の答え）を出さない。出すのは id・状態・時間・使った量・数だけ。
import { randomUUID } from 'node:crypto'
import { checkSet, checkSetSha } from '../../core/checks/index.ts'
import { collectInspection } from './collect.ts'
import * as ins from '../../db/inspections.ts'
import { tx } from '../../db/pool.ts'
import { contextFields, type WorkerContext, type WorkerDeps } from '../jobs.ts'
import { safeAiJobErrorCode, writeAiJobEvent, writeAiQueueSnapshot } from '../ai-job-observability.ts'
import { inspect } from './index.ts'

const log = (rec: Record<string, unknown>, context?: WorkerContext) => console.log(JSON.stringify({ severity: 'INFO', ...contextFields(context), ...rec }))

class LeaseLost extends Error { constructor() { super('inspection lease lost') } }

export async function runInspection(deps: WorkerDeps, id: string, context?: WorkerContext): Promise<void> {
  const db = await deps.db()
  const token = randomUUID()
  const claimed = await ins.claimInspection(db, id, token)
  if (!claimed) return log({ msg: 'inspection already taken or done', inspectionId: id }, context)
  const startedAt = Date.now()
  writeAiJobEvent({ jobType: 'inspection', phase: 'started', jobId: id, attempt: claimed.attempts, context })
  const heartbeat = setInterval(() => {
    void ins.extendInspectionLease(db, id, token).catch((e) => log({ msg: 'inspection lease heartbeat failed', inspectionId: id, error: safeAiJobErrorCode((e as Error).name) }, context))
  }, 60_000)
  heartbeat.unref()
  const t0 = Date.now()
  try {
    const set = checkSet(claimed.checkSet)
    const {docs,contextDocs,inputs,availableKinds,target}=await collectInspection(db,claimed)
    const inputsSha=ins.valuesSha([...docs,...contextDocs].map(d=>({documentId:d.id,values:d.values,formVersionId:inputs.find(i=>i.documentId===d.id)?.formVersionId})))

    // 2・3. 判定
    const providers = await deps.providers()
    if (!providers.inspect) throw new Error('点検の AI がありません')
    const llm = providers.inspect()
    const r = await inspect({ set, docs,contextDocs,llm })

    // 4. 残す（印がまだ自分のものなら）
    const status = !r.findings.length || r.findings.some((f) => f.level === null) ? 'partial' : 'succeeded'
    const steps = {
      collect: { documents: docs.length,referenceDocuments:contextDocs.length,availableKinds },
      rule: { items: r.ruleItems },
      ai: { items: r.aiItems, calls: r.usage.calls, promptTokens: r.usage.promptTokens, cachedTokens: r.usage.cachedTokens, outputTokens: r.usage.outputTokens, thinkingTokens: r.usage.thinkingTokens, yen: r.usage.yen },
      totalSeconds: (Date.now() - t0) / 1000,
    }
    const ok = await tx(db, async (c) => {
      const u = await c.query(
        `UPDATE inspections SET status = $3, inputs = $4, inputs_sha = $5, check_set_sha = $6, steps = $7, document_id=$8,lease_until = NULL, run_token = NULL, error_kind = NULL, updated_at = now()
         WHERE id = $1 AND run_token = $2 AND status = 'processing' RETURNING id`,
        [id, token, status, JSON.stringify(inputs), inputsSha, checkSetSha(set), JSON.stringify(steps),target.id],
      )
      if (!u.rows.length) return false
      await c.query('DELETE FROM inspection_findings WHERE inspection_id = $1', [id])
      for (const f of r.findings) {
        await c.query(
          'INSERT INTO inspection_findings (inspection_id, item, office_id, ai_level, ai_reason, missing, field_key,document_id) VALUES ($1, $2, $3, $4, $5, $6, $7,$8)',
          [id, f.item, claimed.officeId, f.level, JSON.stringify({ met: f.met, by: f.by }), f.missing, f.fieldKey,f.documentId],
        )
      }
      return true
    })
    if (!ok) throw new LeaseLost()
    writeAiJobEvent({ jobType: 'inspection', phase: status === 'partial' ? 'partial' : 'succeeded', jobId: id, attempt: claimed.attempts, durationMs: Date.now() - startedAt, usage: r.usage, counts: { item_count: r.findings.length, missing_count: r.findings.filter((f) => f.level === '1').length }, context })
    log({ msg: 'inspection done', inspectionId: id, status, seconds: steps.totalSeconds, items: r.findings.length, missing: r.findings.filter((f) => f.level === '1').length, calls: r.usage.calls, yen: r.usage.yen }, context)
  } catch (e) {
    if (e instanceof LeaseLost) return log({ msg: 'inspection lease lost', inspectionId: id }, context)
    const kind = (e as Error)?.name ?? 'Error'
    const retryable = claimed.attempts < ins.MAX_INSPECTION_ATTEMPTS
    await ins.releaseInspection(db, id, token, !retryable, kind)
    writeAiJobEvent({ jobType: 'inspection', phase: retryable ? 'retry' : 'failed', jobId: id, attempt: claimed.attempts, durationMs: Date.now() - startedAt, errorCode: kind, retryable, context })
    console.error(JSON.stringify({ severity: 'ERROR', ...contextFields(context), msg: 'inspection failed', inspectionId: id, error: safeAiJobErrorCode(kind) }))
    // 中身が入りうるので、ローカルで調べるときだけ出す
    if (process.env.DEBUG_JOBS) console.error(e)
    throw e
  } finally {
    clearInterval(heartbeat)
  }
}

/** 見回り: 積み損ね・止まった点検を積み直す。積み直した数 */
export async function reconcileInspections(deps: WorkerDeps, enqueue: (id: string) => Promise<void>): Promise<number> {
  const db = await deps.db()
  const ids = await ins.inspectionsToRequeue(db)
  for (const id of ids) await enqueue(id)
  await writeAiQueueSnapshot(db, 'inspection', ids.length)
  return ids.length
}
