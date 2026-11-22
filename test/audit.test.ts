import assert from 'node:assert/strict'
import test from 'node:test'
import { writeAccessAudit, writeBusinessAudit, writeSecurityAudit, type AuditDb } from '../db/audit.ts'
import { auditContextOf, staffByAuth } from '../db/repo.ts'

function fakeDb() {
  const calls: { sql: string, values: unknown[] }[] = []
  return {
    calls,
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values })
      return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] }
    },
  } as unknown as AuditDb & { calls: { sql: string, values: unknown[] }[] }
}

test('business audit stores the common envelope without event content', async () => {
  const db = fakeDb()
  await writeBusinessAudit(db, {
    officeId: 'office-1',
    actorStaffId: 'staff-1',
    action: 'document.save',
    ids: { clientId: 'client-1', documentId: 'document-1' },
    detail: { fields: 3 },
    context: { requestId: 'request-1', correlationId: 'correlation-1', traceId: 'trace-1', route: '/api/documents/1/save', source: 'api' },
  })

  assert.equal(db.calls.length, 1)
  assert.match(db.calls[0].sql, /occurred_at|audit_events/)
  assert.deepEqual(db.calls[0].values.slice(0, 6), ['office-1', 'staff-1', 'client-1', 'document-1', 'document.save', 'success'])
  assert.deepEqual(db.calls[0].values.slice(6, 11), ['request-1', 'correlation-1', 'trace-1', 'api', '/api/documents/1/save'])
})

test('access audit keeps access-specific fields separate from detail', async () => {
  const db = fakeDb()
  await writeAccessAudit(db, {
    officeId: 'office-1',
    actorStaffId: 'staff-1',
    clientId: 'client-1',
    resourceType: 'client',
    accessMode: 'view',
    action: 'client.view',
    resultCount: 1,
    context: { source: 'api', route: '/api/clients' },
  })

  assert.equal(db.calls.length, 1)
  assert.equal(db.calls[0].values[4], 'client')
  assert.equal(db.calls[0].values[6], 'view')
  assert.equal(db.calls[0].values[7], 'client.view')
  assert.equal(db.calls[0].values[14], 1)
})

test('security audit records actor and target separately', async () => {
  const db = fakeDb()
  await writeSecurityAudit(db, {
    officeId: 'office-1',
    actorStaffId: 'admin-1',
    targetStaffId: 'staff-1',
    targetType: 'staff',
    targetId: 'staff-1',
    action: 'role.change',
    permission: 'staff.manage',
    context: { source: 'api' },
  })

  assert.equal(db.calls.length, 1)
  assert.deepEqual(db.calls[0].values.slice(0, 6), ['office-1', 'admin-1', 'staff-1', 'staff', 'staff-1', 'role.change'])
})

test('audit detail rejects sensitive keys', async () => {
  const db = fakeDb()
  await assert.rejects(
    writeBusinessAudit(db, { officeId: 'office-1', action: 'document.save', detail: { transcript: '秘密' } }),
    /禁止されたキー/,
  )
  assert.equal(db.calls.length, 0)
})

test('audit detail rejects sensitive keys at any nesting level', async () => {
  const db = fakeDb()
  await assert.rejects(
    writeBusinessAudit(db, { officeId: 'office-1', action: 'document.save', detail: { meta: { transcript: '秘密' } } }),
    /禁止されたキー/,
  )
  assert.equal(db.calls.length, 0)
})

test('security audit accepts not_found as an internal audit outcome', async () => {
  const db = fakeDb()
  await writeSecurityAudit(db, { officeId: 'office-1', action: 'staff.lookup', outcome: 'not_found' })
  assert.equal(db.calls[0].values[6], 'not_found')
})

test('staff audit context is not enumerable on the API staff object', async () => {
  const context = { requestId: 'request-1', correlationId: 'correlation-1', source: 'api' as const }
  const db = {
    query: async () => ({
      rows: [{ id: 'staff-1', office_id: 'office-1', name: 'Staff', email: null, role: 'admin', office_name: 'Office' }],
    }),
  } as unknown as AuditDb
  const staff = await staffByAuth(db, 'auth-1', undefined, false, context)

  assert.ok(staff)
  assert.equal('auditContext' in staff, false)
  assert.deepEqual(auditContextOf(staff), context)
})
