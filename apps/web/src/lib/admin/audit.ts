import { createHash } from 'node:crypto'
import type { AdminAuditOutcome, AdminTargetType, Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export type AuditInput = {
  requestId: string
  actorUserId?: string | null
  actorRoleKey?: string | null
  action: string
  outcome: AdminAuditOutcome
  targetType?: AdminTargetType
  targetId?: string
  tenantUserId?: string
  reason?: string
  errorCode?: string
  before?: Prisma.InputJsonValue
  after?: Prisma.InputJsonValue
  ip?: string | null
  userAgent?: string | null
}

type AuditStore = { adminAuditLog: { create(args: { data: Prisma.AdminAuditLogCreateInput }): Promise<unknown> } }

const SAFE_SNAPSHOT_KEYS = new Set(['status', 'version', 'roleKey', 'roleName', 'permissionCount', 'sessionVersion', 'outcome', 'reasonCode'])

export function safeAuditSnapshot(input: unknown): Record<string, string | number | boolean> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
  return Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key, value]) => SAFE_SNAPSHOT_KEYS.has(key) && ['string', 'number', 'boolean'].includes(typeof value))) as Record<string, string | number | boolean>
}

function hash(value: string | null | undefined) {
  return value ? createHash('sha256').update(value).digest('hex') : undefined
}

export function requestIdFor(request?: Request) {
  return request?.headers.get('x-request-id')?.slice(0, 128) || crypto.randomUUID()
}

export function createAdminAuditData(input: AuditInput): Prisma.AdminAuditLogCreateInput {
  return {
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    actorRoleKey: input.actorRoleKey,
    action: input.action,
    outcome: input.outcome,
    targetType: input.targetType,
    targetId: input.targetId,
    tenantUserId: input.tenantUserId,
    reason: input.reason,
    errorCode: input.errorCode,
    before: input.before,
    after: input.after,
    ipHash: hash(input.ip),
    userAgentHash: hash(input.userAgent),
    // The append-only database trigger replaces this placeholder with the chained hash.
    recordHash: '',
  }
}

export function writeAdminAudit(input: AuditInput): Promise<void>
export function writeAdminAudit(store: AuditStore, input: AuditInput): Promise<void>
export async function writeAdminAudit(first: AuditInput | AuditStore, second?: AuditInput) {
  const store = second ? first as AuditStore : db
  const input = second ?? first as AuditInput
  try {
    await store.adminAuditLog.create({ data: createAdminAuditData(input) })
  } catch (error) {
    await db.adminAlertEvent.create({ data: { ruleKey: 'audit.write_failure', metric: 'audit_write_failure', value: 1, threshold: 0, severity: 'critical' } }).catch(() => undefined)
    console.error('ADMIN_AUDIT_WRITE_FAILED', { requestId: input.requestId, action: input.action, error })
    throw error
  }
}
