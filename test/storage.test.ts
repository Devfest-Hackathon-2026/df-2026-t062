import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LocalStorage } from '../api/storage.ts'

async function storage() {
  return new LocalStorage(await mkdtemp(join(tmpdir(), 't062-source-control-')))
}

test('source object control returns decimal metadata and blocks deletion while held', async () => {
  const store = await storage()
  await store.write('source', 'recordings/test.webm', new Uint8Array([1, 2, 3]))
  const control = store.sourceObjects()
  const found = await control.getLiveObjectMetadata('recordings/test.webm')
  assert.equal(found.kind, 'found')
  if (found.kind !== 'found') return
  assert.match(found.metadata.generation, /^\d+$/)
  assert.match(found.metadata.metageneration, /^\d+$/)
  const held = await control.setTemporaryHold('recordings/test.webm', found.metadata.generation, found.metadata.metageneration, true)
  assert.equal(held.kind, 'updated')
  const blocked = await control.deleteObjectGeneration('recordings/test.webm', found.metadata.generation)
  assert.deepEqual(blocked, { kind: 'error', code: 'permission_denied' })
  const current = await control.getLiveObjectMetadata('recordings/test.webm')
  assert.equal(current.kind, 'found')
  if (current.kind !== 'found') return
  const released = await control.setTemporaryHold('recordings/test.webm', current.metadata.generation, current.metadata.metageneration, false)
  assert.equal(released.kind, 'updated')
  const deleted = await control.deleteObjectGeneration('recordings/test.webm', current.metadata.generation)
  assert.deepEqual(deleted, { kind: 'deleted' })
  assert.deepEqual(await control.getLiveObjectMetadata('recordings/test.webm'), { kind: 'not_found' })
})

test('source object control rejects a stale generation without touching the live object', async () => {
  const store = await storage()
  await store.write('source', 'recordings/race.webm', new Uint8Array([1]))
  const control = store.sourceObjects()
  const first = await control.getLiveObjectMetadata('recordings/race.webm')
  assert.equal(first.kind, 'found')
  if (first.kind !== 'found') return
  await store.remove('source', 'recordings/race.webm')
  await store.write('source', 'recordings/race.webm', new Uint8Array([2]))
  const result = await control.deleteObjectGeneration('recordings/race.webm', first.metadata.generation)
  assert.deepEqual(result, { kind: 'error', code: 'precondition_failed' })
  const live = await control.getLiveObjectMetadata('recordings/race.webm')
  assert.equal(live.kind, 'found')
  if (live.kind === 'found') assert.notEqual(live.metadata.generation, first.metadata.generation)
})

test('local resumable upload cancellation invalidates the session and preserves completed files', async () => {
  const store = await storage()
  const cancelUrl = await store.createUploadSession('source', 'recordings/unfinished.webm')
  assert.deepEqual(await store.sourceObjects().cancelUploadSession(cancelUrl), { kind: 'cancelled' })
  assert.deepEqual(await store.sourceObjects().cancelUploadSession(cancelUrl), { kind: 'inactive' })

  const completeUrl = await store.createUploadSession('source', 'recordings/complete.webm')
  const token = completeUrl.split('/').at(-1)!
  assert.equal((await store.receive(token, 'bytes 0-2/3', new Uint8Array([1, 2, 3]))).status, 200)
  assert.deepEqual(await store.sourceObjects().cancelUploadSession(completeUrl), { kind: 'inactive' })
  assert.equal(await store.size('source', 'recordings/complete.webm'), 3)
})
