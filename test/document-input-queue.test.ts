import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalQueue } from '../api/queue.ts'

test('ローカルのAI点検と書類取込を、それぞれの処理へ順番どおり送る', async () => {
  const seen: string[] = []
  let finish!: () => void
  const done = new Promise<void>((resolve) => { finish = resolve })
  const queue = new LocalQueue(async () => {}, async () => {},
    async (id) => { seen.push(`inspect:${id}`) },
    async (id) => { seen.push(`document:${id}`); finish() })
  await queue.enqueueInspection('i')
  await queue.enqueueDocumentInput('d')
  await done
  assert.deepEqual(seen, ['inspect:i', 'document:d'])
})
