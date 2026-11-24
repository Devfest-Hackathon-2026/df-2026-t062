import assert from 'node:assert/strict'
import { test } from 'node:test'
import { savePlanEdits, documentDirty } from '../src/components/care-plan/save.ts'

test('入力送信済みでも、保存値と違う手入力があれば未保存を維持する', () => {
  assert.equal(documentDirty({ hasLocalEdits: false, current: { 'person.name': '直した氏名' }, saved: { 'person.name': '前の氏名' } }), true)
  assert.equal(documentDirty({ hasLocalEdits: false, current: { a: 1, b: 2 }, saved: { b: 2, a: 1 } }), false)
  assert.equal(documentDirty({ hasLocalEdits: true, current: {}, saved: {} }), true)
})

test('各表の保存は第1表の入力送信→第2表→第3表→3表の保存の順で、更新後のbaseVersionを使う', async () => {
  const calls: string[] = []
  const result = await savePlanEdits({
    flush: async () => { calls.push('first'); return true },
    needs: async () => { calls.push('needs'); return 4 },
    schedule: async (version) => { calls.push(`schedule:${version}`); return 5 },
    save: async (version) => { calls.push(`save:${version}`); return 'saved' },
  })
  assert.equal(result, 'saved')
  assert.deepEqual(calls, ['first', 'needs', 'schedule:4', 'save:5'])
})

test('入力送信・途中の更新に失敗したら保存と確定を勝手に進めない', async () => {
  let saves = 0
  const steps = {
    flush: async () => false,
    needs: async () => { throw new Error('呼ばれてはいけない') },
    schedule: async () => 3,
    save: async () => { saves++; return true },
  }
  await assert.rejects(savePlanEdits(steps))
  await assert.rejects(savePlanEdits({ ...steps, flush: async () => true }))
  assert.equal(saves, 0)
})
