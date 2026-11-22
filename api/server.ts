import { createAdaptorServer } from '@hono/node-server'
import { createApp, type ApiDeps } from './app.ts'
import { defaultAccounts, defaultVerifier, type Accounts, type Verifier } from './auth.ts'
import type { ChatModel } from './chat.ts'
import type { CarePlanDrafter } from '../db/care-plans.ts'
import type { FieldMatcher } from '../core/slot-meaning.ts'
import type { TopicDrafter } from '../core/topics.ts'
import { CloudTasksQueue, LocalQueue, type Queue } from './queue.ts'
import { defaultStorage, type Storage } from './storage.ts'

/** 依存は使うときに作る（health では DB にも Firebase にもつながない） */
export function defaultApiDeps(env: NodeJS.ProcessEnv = process.env): ApiDeps {
  let verifier: Verifier | undefined
  let accounts: Accounts | undefined
  let storage: Storage | undefined
  let queue: Queue | undefined
  let chat: Promise<ChatModel> | undefined
  let carePlanAi: Promise<CarePlanDrafter> | undefined
  let matcher: Promise<FieldMatcher> | undefined
  let drafter: Promise<TopicDrafter> | undefined
  const getStorage = () => (storage ??= defaultStorage(env))
  return {
    db: async () => (await import('../db/pool.ts')).getDb(),
    verifier: () => (verifier ??= defaultVerifier(env)),
    storage: getStorage,
    queue: () => {
      if (queue) return queue
      if (env.QUEUE_MODE === 'tasks') return (queue = new CloudTasksQueue(env))
      // ローカル: 同じプロセスで worker の処理を呼ぶ
      const workerDeps = async () => {
        const [{ defaultProviders }, { getDb }] = await Promise.all([import('../worker/providers.ts'), import('../db/pool.ts')])
        return { db: getDb, storage: getStorage, providers: () => defaultProviders(env) }
      }
      return (queue = new LocalQueue(
        async (jobId) => (await import('../worker/jobs.ts')).runJob(await workerDeps(), jobId),
        async (importId) => (await import('../worker/form-import/job.ts')).runFormImport(await workerDeps(), importId),
        async (inspectionId) => (await import('../worker/inspect/job.ts')).runInspection(await workerDeps(), inspectionId),
        async (id) => (await import('../worker/document-input/job.ts')).runDocumentInput(await workerDeps(), id),
        async (recordingId, operationVersion) => (await import('../worker/recording-cleanup-service.ts')).synchronizeRetentionHold(await workerDeps(), recordingId, operationVersion),
        async (id) => (await import('../worker/document-fill/job.ts')).runDocumentFill(await workerDeps(), id),
      ))
    },
    chat: () => (chat ??= defaultChat(env)),
    carePlanAi: () => (carePlanAi ??= defaultCarePlanAi(env)),
    fieldMatcher: () => (matcher ??= defaultFieldMatcher(env)),
    topicDrafter: () => (drafter ??= defaultTopicDrafter(env)),
    devAuth: env.AUTH_MODE === 'dev',
    accounts: () => (accounts ??= defaultAccounts(env)),
  }
}

/** AI_PROVIDER=vertex なら Gemini（関数呼び出し）。既定は試しの答え（費用なし） */
async function defaultChat(env: NodeJS.ProcessEnv): Promise<ChatModel> {
  if (env.AI_PROVIDER !== 'vertex') return (await import('./chat.ts')).fakeModel
  return (await import('./gemini-chat.ts')).geminiChatModel(env)
}

/** AI_PROVIDER=vertex なら Gemini。既定は空の試しの原案（費用なし） */
async function defaultCarePlanAi(env: NodeJS.ProcessEnv): Promise<CarePlanDrafter> {
  if (env.AI_PROVIDER !== 'vertex') return (await import('./care-plan-ai.ts')).fakeCarePlanDrafter
  return (await import('./care-plan-ai.ts')).geminiCarePlanDrafter(env)
}

/** 責任者の言葉を欄に当てはめる。AI_PROVIDER=vertex なら Gemini。既定は試しの当てはめ（欄の名前が言葉に入っているか。費用なし） */
async function defaultFieldMatcher(env: NodeJS.ProcessEnv): Promise<FieldMatcher> {
  if (env.AI_PROVIDER !== 'vertex') return (await import('../core/slot-meaning.ts')).fakeFieldMatcher
  return (await import('./field-match.ts')).geminiFieldMatcher(env)
}

/** 事業所が足した書類の拾う内容の案。AI_PROVIDER=vertex なら Gemini。既定は試しの案（欄の言葉をそのまま項目にする。費用なし） */
async function defaultTopicDrafter(env: NodeJS.ProcessEnv): Promise<TopicDrafter> {
  if (env.AI_PROVIDER !== 'vertex') return (await import('../core/topics.ts')).fakeTopicDrafter
  return (await import('./topic-draft.ts')).geminiTopicDrafter(env)
}

export function createApiServer(deps: ApiDeps = defaultApiDeps()) {
  return createAdaptorServer({ fetch: createApp(deps).fetch })
}
