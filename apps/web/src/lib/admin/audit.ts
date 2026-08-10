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

export async function writeAdminAudit(input: AuditInput) {
  try {
    await db.adminAuditLog.create({ data: createAdminAuditData(input) })
  } catch (error) {
    await db.adminAlertEvent.create({ data: { ruleKey: 'audit.write_failure', metric: 'audit_write_failure', value: 1, threshold: 0, severity: 'critical' } }).catch(() => undefined)
    console.error('ADMIN_AUDIT_WRITE_FAILED', { requestId: input.requestId, action: input.action, error })
    throw error
  }
}
