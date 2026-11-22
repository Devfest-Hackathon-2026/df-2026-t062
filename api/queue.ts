// ジョブを積む。
//   QUEUE_MODE=tasks: Cloud Tasks。worker の /tasks/jobs/<id>/run（録音）・/tasks/form-imports/<id>/run（様式の取り込み）・
//     /tasks/inspections/<id>/run（AI 点検）を OIDC トークンつきで呼ぶ
//   QUEUE_MODE=local（既定）: 同じプロセスで worker の処理を呼ぶ（ローカルとテスト）
export interface Queue {
  enqueueDocumentInput?(id: string, options?: { initial: boolean }): Promise<void>
  /** 録音 1 本の処理 */
  enqueue(jobId: string, options?: { initial: boolean }): Promise<void>
  /** 上げた PDF から様式の下書きを作る */
  enqueueFormImport(importId: string, options?: { initial: boolean }): Promise<void>
  /** AI 点検 */
  enqueueInspection(inspectionId: string, options?: { initial: boolean }): Promise<void>
  enqueueRetentionHold?(recordingId: string, operationVersion: string): Promise<void>
}

export class CloudTasksQueue implements Queue {
  private client: Promise<import('@google-cloud/tasks').CloudTasksClient> | undefined
  private env: NodeJS.ProcessEnv

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env
  }

  enqueue(jobId: string, options?: { initial: boolean }) {
    return this.createTask(`job-${jobId}`, `/tasks/jobs/${jobId}/run`, options)
  }

  enqueueFormImport(importId: string, options?: { initial: boolean }) {
    return this.createTask(`form-import-${importId}`, `/tasks/form-imports/${importId}/run`, options)
  }

  enqueueDocumentInput(id: string, options?: { initial: boolean }) {
    return this.createTask(`document-input-${id}`, `/tasks/document-inputs/${id}/run`, options)
  }

  enqueueInspection(inspectionId: string, options?: { initial: boolean }) {
    return this.createTask(`inspection-${inspectionId}`, `/tasks/inspections/${inspectionId}/run`, options)
  }

  enqueueRetentionHold(recordingId: string, operationVersion: string) {
    return this.createTask(`retention-hold-${recordingId}-${operationVersion}`, `/tasks/recordings/${recordingId}/retention-hold-sync`, undefined, { recordingId, operationVersion })
  }

  private async createTask(name: string, path: string, options?: { initial: boolean }, body: Record<string, unknown> = {}) {
    const { TASKS_QUEUE, WORKER_URL, TASKS_INVOKER_SA } = this.env
    if (!TASKS_QUEUE || !WORKER_URL || !TASKS_INVOKER_SA) throw new Error('TASKS_QUEUE・WORKER_URL・TASKS_INVOKER_SA を設定してください')
    this.client ??= import('@google-cloud/tasks').then((m) => new m.CloudTasksClient())
    const client = await this.client
    const attempt = options?.initial ? 'initial' : Date.now().toString(36)
    await client.createTask({
      parent: TASKS_QUEUE,
      task: {
        // 最初の投入は同じ名前を使う（2 回積んでも 1 つ）。見回りでの積み直しには別の名前が必要。
        name: `${TASKS_QUEUE}/tasks/${name}-${attempt}`,
        dispatchDeadline: { seconds: 1800 },
        httpRequest: {
          httpMethod: 'POST',
          url: `${WORKER_URL}${path}`,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(body)).toString('base64'),
          // audience は worker の URL（パスを含めない）
          oidcToken: { serviceAccountEmail: TASKS_INVOKER_SA, audience: WORKER_URL },
        },
      },
    }).catch((e: unknown) => {
      if (!options?.initial || (e as { code?: number }).code !== 6) throw e // ALREADY_EXISTS
    })
  }
}

export class LocalQueue implements Queue {
  private run: (jobId: string) => Promise<void>
  private runImport: (importId: string) => Promise<void>
  private runDocument: (id: string) => Promise<void>
  private runInspection: (inspectionId: string) => Promise<void>
  private runRetentionHold: (recordingId: string, operationVersion: string) => Promise<void>
  private tail = Promise.resolve()

  constructor(
    run: (jobId: string) => Promise<void>,
    runImport: (importId: string) => Promise<void> = async () => {},
    runInspection: (inspectionId: string) => Promise<void> = async () => {},
    runDocument: (id: string) => Promise<void> = async () => {},
    runRetentionHold: (recordingId: string, operationVersion: string) => Promise<void> = async () => {},
  ) {
    this.run = run
    this.runImport = runImport
    this.runInspection = runInspection
    this.runDocument = runDocument
    this.runRetentionHold = runRetentionHold
  }

  async enqueue(jobId: string) {
    this.later(() => this.run(jobId), { msg: 'job failed', jobId })
  }

  async enqueueFormImport(importId: string) {
    this.later(() => this.runImport(importId), { msg: 'form import failed', importId })
  }

  async enqueueDocumentInput(id: string) {
    this.later(() => this.runDocument(id), { msg: 'document input failed', id })
  }

  async enqueueInspection(inspectionId: string) {
    this.later(() => this.runInspection(inspectionId), { msg: 'inspection failed', inspectionId })
  }

  async enqueueRetentionHold(recordingId: string, operationVersion: string) {
    this.later(() => this.runRetentionHold(recordingId, operationVersion), { msg: 'retention hold sync failed', recordingId })
  }

  // ローカルには見回りがないため、先の処理が終わってから次を処理する。
  private later(fn: () => Promise<void>, log: Record<string, string>) {
    this.tail = this.tail.then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(fn)
      .catch((e) => console.error(JSON.stringify({ ...log, error: String(e?.name ?? 'Error') })))
  }
}
