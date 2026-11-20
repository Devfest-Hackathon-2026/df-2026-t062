// worker の道。Cloud Run の設定で非公開にし、Cloud Tasks と Cloud Scheduler のサービスアカウントだけが呼べる。
import { reconcileDocumentInputs, runDocumentInput } from './document-input/job.ts'
import { Hono } from 'hono'
import { reconcile, runJob, type WorkerDeps } from './jobs.ts'
import { reconcileFormImports, runFormImport } from './form-import/job.ts'

export interface WorkerQueue {
  enqueueDocumentInput?(id: string): Promise<void>
  enqueue(jobId: string): Promise<void>
  enqueueFormImport(importId: string): Promise<void>
}

export function createWorkerApp(deps: WorkerDeps, queue: WorkerQueue) {
  const app = new Hono()
  app.get('/health', (c) => c.json({ status: 'ok', source: 'worker' }))
  // 処理は応答の前に終える（Cloud Run は応答のあとの処理を遅くする）。失敗したら 500 で、Cloud Tasks が間をあけてやり直す
  app.post('/tasks/jobs/:id/run', async (c) => {
    await runJob(deps, c.req.param('id'))
    return c.json({ ok: true })
  })
  // 上げた PDF から様式の下書きを作る（#103）
  app.post('/tasks/form-imports/:id/run', async (c) => {
    await runFormImport(deps, c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/tasks/document-inputs/:id/run', async (c) => {
    await runDocumentInput(deps, c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/tasks/reconcile', async (c) => c.json({
    documentInputs: queue.enqueueDocumentInput ? await reconcileDocumentInputs(deps, (id) => queue.enqueueDocumentInput!(id)) : 0,
    requeued: await reconcile(deps, (id) => queue.enqueue(id)),
    formImports: await reconcileFormImports(deps, (id) => queue.enqueueFormImport(id)),
  }))
  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  app.onError((err, c) => {
    console.error(JSON.stringify({ severity: 'ERROR', msg: 'worker error', path: c.req.routePath, error: err.name }))
    return c.json({ error: 'internal' }, 500)
  })
  return app
}
