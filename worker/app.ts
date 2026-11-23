// worker の道。Cloud Run の設定で非公開にし、Cloud Tasks と Cloud Scheduler のサービスアカウントだけが呼べる。
import { randomUUID } from 'node:crypto'
import { reconcileDocumentInputs, runDocumentInput } from './document-input/job.ts'
import { Hono, type Context } from 'hono'
import { contextFields, reconcile, runJob, type WorkerContext, type WorkerDeps } from './jobs.ts'
import { reconcileFormImports, runFormImport } from './form-import/job.ts'
import { reconcileInspections, runInspection } from './inspect/job.ts'
import { synchronizeRetentionHold } from './recording-cleanup-service.ts'
import { reconcileDocumentFills, runDocumentFill } from './document-fill/job.ts'

export interface WorkerQueue {
  enqueueDocumentInput?(id: string): Promise<void>
  enqueue(jobId: string): Promise<void>
  enqueueFormImport(importId: string): Promise<void>
  enqueueInspection(inspectionId: string): Promise<void>
  enqueueRetentionHold?(recordingId: string, operationVersion: string): Promise<void>
  enqueueDocumentFill?(fillId: string): Promise<void>
}

export function createWorkerApp(deps: WorkerDeps, queue: WorkerQueue) {
  const app = new Hono()
  const requestContexts = new WeakMap<object, WorkerContext>()
  const contextOf = (c: Context) => requestContexts.get(c) ?? {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    traceId: c.req.header('x-cloud-trace-context')?.split('/')[0],
  }
  app.use('*', async (c, next) => {
    const context = {
      requestId: randomUUID(),
      correlationId: randomUUID(),
      traceId: c.req.header('x-cloud-trace-context')?.split('/')[0],
    }
    requestContexts.set(c, context)
    c.header('X-Request-Id', context.requestId)
    await next()
  })
  app.get('/health', (c) => c.json({ status: 'ok', source: 'worker' }))
  // 処理は応答の前に終える（Cloud Run は応答のあとの処理を遅くする）。失敗したら 500 で、Cloud Tasks が間をあけてやり直す
  app.post('/tasks/jobs/:id/run', async (c) => {
    await runJob(deps, c.req.param('id'), contextOf(c))
    return c.json({ ok: true })
  })
  // 上げた PDF から様式の下書きを作る（#103）
  app.post('/tasks/form-imports/:id/run', async (c) => {
    await runFormImport(deps, c.req.param('id'), {}, contextOf(c))
    return c.json({ ok: true })
  })
  app.post('/tasks/document-inputs/:id/run', async (c) => {
    await runDocumentInput(deps, c.req.param('id'), contextOf(c))
    return c.json({ ok: true })
  })
  // AI 点検（#113）
  app.post('/tasks/inspections/:id/run', async (c) => {
    await runInspection(deps, c.req.param('id'), contextOf(c))
    return c.json({ ok: true })
  })
  app.post('/tasks/recordings/:id/retention-hold-sync', async (c) => {
    const body: { recordingId?: string, operationVersion?: string } = await c.req.json<{ recordingId?: string, operationVersion?: string }>().catch(() => ({ recordingId: undefined, operationVersion: undefined }))
    if (!body.operationVersion || body.recordingId !== c.req.param('id')) return c.json({ error: 'bad_request' }, 400)
    await synchronizeRetentionHold(deps, c.req.param('id'), body.operationVersion)
    return c.json({ ok: true })
  })
  // 書類を作るときに AI が書く（#195）
  app.post('/tasks/document-fills/:id/run', async (c) => {
    await runDocumentFill(deps, c.req.param('id'), contextOf(c))
    return c.json({ ok: true })
  })
  app.post('/tasks/reconcile', async (c) => c.json({
    documentInputs: queue.enqueueDocumentInput ? await reconcileDocumentInputs(deps, (id) => queue.enqueueDocumentInput!(id)) : 0,
    requeued: await reconcile(deps, (id) => queue.enqueue(id)),
    formImports: await reconcileFormImports(deps, (id) => queue.enqueueFormImport(id)),
    inspections: await reconcileInspections(deps, (id) => queue.enqueueInspection(id)),
    documentFills: queue.enqueueDocumentFill ? await reconcileDocumentFills(deps, (id) => queue.enqueueDocumentFill!(id)) : 0,
  }))
  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  app.onError((err, c) => {
    const context = contextOf(c)
    console.error(JSON.stringify({ severity: 'ERROR', ...contextFields(context), msg: 'worker error', path: c.req.routePath, error: err.name }))
    return c.json({ error: 'internal' }, 500)
  })
  return app
}
