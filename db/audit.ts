import type { Db, Tx } from './pool.ts'

export type AuditDb = Db | Tx
export type AuditOutcome = 'success' | 'denied' | 'not_found' | 'error'
export type SecurityAuditOutcome = 'success' | 'denied' | 'not_found' | 'error'
export type AuditSource = 'api' | 'worker' | 'cli' | 'scheduler' | 'system' | 'legacy'

export interface AuditContext {
  requestId?: string
  correlationId?: string
  traceId?: string
  route?: string
  source?: AuditSource
}

export interface AccessAuditContext extends AuditContext {
  route: string
}

export interface AuditIds {
  clientId?: string
  documentId?: string
  resourceType?: string
  resourceId?: string
}

const forbiddenKeys = /authorization|token|password|secret|prompt|response|transcript|utterance|audio|url|name|address|phone|birth/i
const safeMetadataString = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/
const MAX_DETAIL_BYTES = 4096

function validateDetail(value: unknown, depth = 0, active = new Set<object>()): void {
  if (depth > 8) throw new Error('監査detailのネストが深すぎます')
  if (typeof value === 'string' && !safeMetadataString.test(value)) throw new Error('監査detailに自由文字列は保存できません')
  if (!value || typeof value !== 'object') return
  if (active.has(value)) throw new Error('監査detailに循環参照があります')
  active.add(value)
  if (Array.isArray(value)) {
    for (const item of value) validateDetail(item, depth + 1, active)
  } else {
    for (const [key, nested] of Object.entries(value)) {
      if (forbiddenKeys.test(key)) throw new Error('監査detailに禁止されたキーがあります')
      validateDetail(nested, depth + 1, active)
    }
  }
  active.delete(value)
}

function safeDetail(detail: Record<string, unknown>): string {
  validateDetail(detail)
  const serialized = JSON.stringify(detail)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DETAIL_BYTES) throw new Error('監査detailが大きすぎます')
  return serialized
}

function common(context: AuditContext = {}) {
  return {
    requestId: context.requestId ?? null,
    correlationId: context.correlationId ?? null,
    traceId: context.traceId ?? null,
    source: context.source ?? 'system',
    route: context.route ?? null,
  }
}

export async function writeBusinessAudit(
  db: AuditDb,
  input: { officeId: string | null, actorStaffId?: string | null, action: string, ids?: AuditIds, detail?: Record<string, unknown>, outcome?: AuditOutcome, context?: AuditContext },
) {
  const ids = input.ids ?? {}
  const c = common(input.context)
  await db.query(
    `INSERT INTO audit_events
       (office_id, staff_id, client_id, document_id, action, outcome, request_id, correlation_id, trace_id, source, route, schema_version, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12)`,
    [input.officeId, input.actorStaffId ?? null, ids.clientId ?? null, ids.documentId ?? null, input.action,
      input.outcome ?? 'success', c.requestId, c.correlationId, c.traceId, c.source, c.route, safeDetail(input.detail ?? {})],
  )
}

export async function writeAccessAudit(
  db: AuditDb,
  input: { officeId: string, actorStaffId?: string | null, clientId?: string | null, documentId?: string | null, resourceType: string, resourceId?: string | null, accessMode: string, action: string, outcome?: AuditOutcome, resultCount?: number | null, displayedClientIds?: string[] | null, detail?: Record<string, unknown>, context: AccessAuditContext },
) {
  const c = common(input.context)
  await db.query(
    `INSERT INTO access_audit_events
       (office_id, actor_staff_id, client_id, document_id, resource_type, resource_id, access_mode, action, outcome,
        request_id, correlation_id, trace_id, source, route, schema_version, result_count, displayed_client_ids, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$17)`,
    [input.officeId, input.actorStaffId ?? null, input.clientId ?? null, input.documentId ?? null, input.resourceType,
      input.resourceId ?? null, input.accessMode, input.action, input.outcome ?? 'success', c.requestId, c.correlationId,
      c.traceId, c.source, c.route, input.resultCount ?? null,
      input.displayedClientIds ? JSON.stringify(input.displayedClientIds) : null, safeDetail(input.detail ?? {})],
  )
}

export async function writeSecurityAudit(
  db: AuditDb,
  input: { officeId?: string | null, actorStaffId?: string | null, targetStaffId?: string | null, targetType?: string | null, targetId?: string | null, action: string, outcome?: SecurityAuditOutcome, reasonCode?: string | null, authMethod?: string | null, permission?: string | null, detail?: Record<string, unknown>, context?: AuditContext },
) {
  const c = common(input.context)
  await db.query(
    `INSERT INTO security_audit_events
       (office_id, actor_staff_id, target_staff_id, target_type, target_id, action, outcome, request_id, correlation_id,
        trace_id, source, route, schema_version, reason_code, auth_method, permission, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$14,$15,$16)`,
    [input.officeId ?? null, input.actorStaffId ?? null, input.targetStaffId ?? null, input.targetType ?? null,
      input.targetId ?? null, input.action, input.outcome ?? 'success', c.requestId, c.correlationId, c.traceId,
      c.source, c.route, input.reasonCode ?? null, input.authMethod ?? null, input.permission ?? null,
      safeDetail(input.detail ?? {})],
  )
}
