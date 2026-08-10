import { db } from '@/lib/db'
import { toAdminUserDto } from '@/lib/admin/dto'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'

const USER_SELECT = {
  id: true, email: true, name: true, plan: true, accountStatus: true, location: true,
  createdAt: true, updatedAt: true, suspendedAt: true,
  _count: { select: { resumes: true, jobs: true, applicationTasks: true } },
} as const

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('users.suspend', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const body = await jsonBody(request)
    const status = parseStatus(body.status)
    if (status === 'active' && !actor.permissions.includes('users.restore')) return adminJson({ error: 'ADMIN_PERMISSION_DENIED' }, 403, correlationId)
    const reason = requiredReason(body)
    const updatedAt = parseTimestamp(body.updatedAt)
    const idempotencyKey = requiredIdempotencyKey(request)
    const { id } = await context.params
    const current = await db.user.findUnique({ where: { id }, select: { id: true, accountStatus: true, updatedAt: true } })
    if (!current) return adminJson({ error: 'ADMIN_USER_NOT_FOUND' }, 404, correlationId)
    if (current.accountStatus === status) return adminJson({ error: 'ADMIN_ACCOUNT_STATE_UNCHANGED' }, 409, correlationId)
    const response = await withAdminIdempotency(db, {
      actorUserId: actor.userId, key: idempotencyKey, action: 'admin.user.account_state', body: { id, status, updatedAt: updatedAt.toISOString(), reason },
    }, async transaction => {
      const result = await transaction.user.updateMany({
        where: { id, updatedAt },
        data: {
          accountStatus: status,
          suspendedAt: status === 'suspended' ? new Date() : null,
          suspendedById: status === 'suspended' ? actor.userId : null,
          suspensionReason: status === 'suspended' ? reason : null,
        },
      })
      if (result.count !== 1) throw new Error('VERSION_CONFLICT')
      const user = await transaction.user.findUnique({ where: { id }, select: USER_SELECT })
      if (!user) throw new Error('ADMIN_USER_NOT_FOUND')
      await transaction.adminAuditLog.create({ data: {
        requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey,
        action: 'admin.user.account_state', targetType: 'user', targetId: id, tenantUserId: id,
        reason, outcome: 'success', before: { status: current.accountStatus }, after: { status: user.accountStatus },
      } })
      return { status: 200, body: { user: toAdminUserDto(user) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) {
    if (error instanceof Error && error.message === 'VERSION_CONFLICT') return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId)
    return adminError(error, correlationId)
  }
}

function parseStatus(value: unknown): 'active' | 'suspended' {
  if (value === 'active' || value === 'suspended') return value
  throw new Error('Invalid account status')
}

function parseTimestamp(value: unknown): Date {
  if (typeof value !== 'string') throw new Error('updatedAt is required')
  const result = new Date(value)
  if (Number.isNaN(result.getTime())) throw new Error('updatedAt is invalid')
  return result
}
