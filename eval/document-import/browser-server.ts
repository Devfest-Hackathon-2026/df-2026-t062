// ブラウザで取込導線を確かめるための合成応答。実資料の読取精度は評価しない。
import { createApiServer } from '../../api/server.ts'
import { DevVerifier } from '../../api/auth.ts'
import { LocalStorage } from '../../api/storage.ts'
import { LocalQueue } from '../../api/queue.ts'
import { getDb } from '../../db/pool.ts'
import { defaultProviders } from '../../worker/providers.ts'
import { ZERO_USAGE, type Providers } from '../../worker/types.ts'
import { runDocumentInput } from '../../worker/document-input/job.ts'

if (!process.env.DB_SCHEMA?.startsWith('e2e_') || !process.env.LOCAL_STORAGE_DIR || process.env.AI_PROVIDER === 'vertex') {
  throw new Error('e2e_で始まる隔離DB_SCHEMA・専用LOCAL_STORAGE_DIR・AI_PROVIDER=fakeを指定してください')
}
const storage = new LocalStorage()
const providers: Providers = {
  ...await defaultProviders({ AI_PROVIDER: 'fake' }),
  documentRead: () => ({
    ask: async () => ({ entries: [{
      text: '移動は一部介助、食事は見守り。相談経路は地域包括支援センター。',
      recordedOn: '2026-11-01', region: null, uncertain: false,
    }], issues: [] }),
    usage: () => ZERO_USAGE,
  }),
  documentWrite: {
    summarizer: { async summarize(input) {
      const entries = input.records![0].scenes[0].entries
      const topic = input.topics.find((t) => t.by === 'ai')!.id
      return { texts: { [topic]: entries.map((e) => e.text).join('\n') },
        sourceIds: { [topic]: entries.map((e) => e.id) }, usage: ZERO_USAGE }
    } },
    writer: { async write(input) {
      const cite = { kind: 'summary' as const, ids: [input.summaries[0].id] }
      return { values: {
        'survey.2_2': { value: '一部介助', cite },
        'survey.2_4': { value: '見守り等', cite },
        'intake.referralRoute': { value: '地域包括支援センターから', cite },
      }, usage: ZERO_USAGE, failed: [], incompleteFields: [] }
    } },
  },
}
const queue = new LocalQueue(async () => {}, async () => {}, async () => {},
  (id) => runDocumentInput({ db: getDb, storage: () => storage, providers: async () => providers }, id))
createApiServer({
  db: getDb, verifier: () => new DevVerifier(), storage: () => storage, queue: () => queue, devAuth: true,
}).listen(Number(process.env.PORT ?? 8788), '127.0.0.1', () => console.log('合成応答のブラウザ検証用APIを開始しました'))
