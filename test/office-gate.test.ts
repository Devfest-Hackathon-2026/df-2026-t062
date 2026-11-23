import assert from 'node:assert/strict'
import { test } from 'node:test'
import { officeGate } from '../src/app/officeGate.ts'

test('責任者でない人が書類の設定を開くと、一覧に流れず「責任者だけ」と出す', () => {
  const g = officeGate({ name: 'office' }, 'caremanager', 'pc')
  assert.equal(g.ok, false)
  assert.match(g.ok ? '' : g.message, /責任者だけ/)
})

test('責任者でも iPad では、PC で開くよう出す（iPad で一覧に流れない）', () => {
  const g = officeGate({ name: 'officeKind', kind: 'admission' }, 'admin', 'pad')
  assert.equal(g.ok, false)
  assert.match(g.ok ? '' : g.message, /PC/)
})

test('責任者が PC で開けば、書類の設定の画面を通す', () => {
  assert.deepEqual(officeGate({ name: 'officeAdd' }, 'admin', 'pc'), { ok: true })
})

test('書類の設定でない画面は、役割や端末に関係なく止めない', () => {
  assert.deepEqual(officeGate({ name: 'list' }, 'caremanager', 'pc'), { ok: true })
  assert.deepEqual(officeGate({ name: 'client', id: 'x' }, 'caremanager', 'pad'), { ok: true })
})
