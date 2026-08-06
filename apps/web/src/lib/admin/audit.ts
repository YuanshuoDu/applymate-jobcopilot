import { createHash } from 'node:crypto'

const SAFE_SNAPSHOT_KEYS = new Set([
  'status',
  'version',
  'roleKey',
  'roleName',
  'permissionCount',
  'sessionVersion',
  'outcome',
  'reasonCode',
])

export type AuditOutcome = 'success' | 'denied' | 'failed'

export interface AdminAuditEvent {
  requestId: string
  actorUserId?: string
  actorRoleKey?: string
  action: string
  targetType?: string
  targetId?: string
  tenantUserId?: string
  reason?: string
  outcome: AuditOutcome
  ip?: string
  userAgent?: string
  before?: unknown
  after?: unknown
  errorCode?: string
}

interface AuditStore {
  adminAuditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>
  }
}

export function safeAuditSnapshot(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
  const source = input as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => SAFE_SNAPSHOT_KEYS.has(key) && isSafeValue(value)),
  )
}

export async function writeAdminAudit(store: AuditStore, event: AdminAuditEvent): Promise<unknown> {
  return store.adminAuditLog.create({
    data: {
      requestId: event.requestId,
      actorUserId: event.actorUserId,
      actorRoleKey: event.actorRoleKey,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      tenantUserId: event.tenantUserId,
      reason: sanitizeReason(event.reason),
      outcome: event.outcome,
      ipHash: hashMetadata(event.ip),
      userAgentHash: hashMetadata(event.userAgent),
      before: safeAuditSnapshot(event.before),
      after: safeAuditSnapshot(event.after),
      errorCode: event.errorCode,
    },
  })
}

function isSafeValue(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function hashMetadata(value: string | undefined): string | undefined {
  return value ? createHash('sha256').update(value).digest('hex') : undefined
}

function sanitizeReason(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value
    .trim()
    .slice(0, 500)
    .replace(/(?:sk-|Bearer\s+|AKIA)[A-Za-z0-9_./+=-]+/gi, '[REDACTED]')
    .replace(/\b\d{13,19}\b/g, '[REDACTED]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, '[REDACTED]')
}
