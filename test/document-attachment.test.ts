import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachDocumentInput } from '../src/document-input/attachDocumentInput.ts'
import { api } from '../src/lib/api.ts'

test('画像の選択だけで添付を完了し、期限切れの送信先を一度更新する', async (t) => {
  const requests: string[] = []
  const file = new File(['synthetic image'], '情報.png', { type: 'image/png' })
  const start = t.mock.method(api, 'startDocumentInput', async (_id: string, body: Parameters<typeof api.startDocumentInput>[1]) => {
    assert.equal(body.fileName, file.name)
    assert.equal(body.bytes, file.size)
    assert.match(body.sha256, /^[a-f0-9]{64}$/)
    if (requests.length) assert.equal(body.expiredUploadUrl, 'first')
    return { input: { id: 'attachment' }, uploadUrl: requests.length ? 'renewed' : 'first' } as Awaited<ReturnType<typeof api.startDocumentInput>>
  })
  const complete = t.mock.method(api, 'completeDocumentInput', async () => ({}) as Awaited<ReturnType<typeof api.completeDocumentInput>>)
  const original = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  class Request {
    status = 0
    upload = {}
    onload?: () => void
    open(_method: string, url: string) { requests.push(url) }
    setRequestHeader() {}
    getResponseHeader() { return null }
    send() { this.status = requests.length === 1 ? 410 : 200; this.onload?.() }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: Request })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'XMLHttpRequest', original); else Reflect.deleteProperty(globalThis, 'XMLHttpRequest') })
  await attachDocumentInput('target-document', file, () => {})
  assert.deepEqual(requests, ['first', 'renewed'])
  assert.equal(start.mock.callCount(), 2)
  assert.equal(start.mock.calls[0].arguments[0], 'target-document')
  assert.deepEqual(complete.mock.calls[0].arguments, ['attachment'])
})

test('未対応形式と10 MB超の添付は送信開始前に断る', async (t) => {
  const start = t.mock.method(api, 'startDocumentInput')
  await assert.rejects(attachDocumentInput('doc', new File(['x'], 'table.csv', { type: 'text/csv' }), () => {}), /JPEG・PNG・PDF/)
  await assert.rejects(attachDocumentInput('doc', new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }), () => {}), /10 MB/)
  assert.equal(start.mock.callCount(), 0)
})
