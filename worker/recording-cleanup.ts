import { closePool, getDb } from '../db/pool.ts'
import { defaultStorage } from '../api/storage.ts'
import { lifecycleReadiness } from '../db/recording-retention.ts'
import { runRecordingCleanup } from './recording-cleanup-service.ts'

const storage = defaultStorage()
const deps = { db: getDb, storage: () => storage, providers: async () => { throw new Error('cleanup does not use providers') } }

if (process.argv.includes('--verify-lifecycle-readiness')) {
  const result = await lifecycleReadiness(await getDb())
  console.log(JSON.stringify({ msg: 'recording lifecycle readiness', ...result }))
  await closePool(await getDb())
  if (result.unsyncedHolds > 0 || result.escalatedHolds > 0) process.exitCode = 1
} else {
  const startedAt = Date.now()
  const result = await runRecordingCleanup(deps)
  console.log(JSON.stringify({ msg: 'recording cleanup complete', ...result, durationMs: Date.now() - startedAt }))
  await closePool(await getDb())
}
