import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { toAdminUserDto } from '@/lib/admin/dto'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { planKey } from '@/lib/admin/plans'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason } from '@/lib/admin/route-utils'

const USER_SELECT = { id: true, email: true, name: true, plan: true, accountStatus: true, location: true, createdAt: true, updatedAt: true, suspendedAt: true, _count: { select: { resumes: true, jobs: true, applicationTasks: true } } } as const

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdmin('billing.update', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { id } = await context.params
    const body = await jsonBody(request)
    const reason = requiredReason(body)
    const toPlan = planKey(body.toPlan, 'Target plan')
    const updatedAt = parseTimestamp(body.updatedAt)
    const idempotencyKey = requiredIdempotencyKey(request)
    const current = await db.user.findUnique({ where: { id }, select: { id: true, plan: true, accountStatus: true, updatedAt: true } })
    if (!current) return adminJson({ error: 'ADMIN_USER_NOT_FOUND' }, 404, correlationId)
    if (current.accountStatus === 'suspended') return adminJson({ error: 'SUSPENDED_USER_PLAN_CHANGE_FORBIDDEN' }, 409, correlationId)
    const fromPlan = planKey(current.plan, 'Current plan')
    if (fromPlan === toPlan) return adminJson({ error: 'PLAN_ALREADY_ASSIGNED' }, 409, correlationId)
    const transition = await db.planTransition.findUnique({ where: { fromPlan_toPlan: { fromPlan, toPlan } }, select: { id: true, enabled: true } })
    if (!transition?.enabled) return adminJson({ error: 'PLAN_TRANSITION_DISABLED' }, 409, correlationId)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.user.plan', body: { id, fromPlan, toPlan, updatedAt: updatedAt.toISOString(), reason } }, async transaction => {
      const updated = await transaction.user.updateMany({ where: { id, updatedAt }, data: { plan: toPlan } })
      if (updated.count !== 1) throw new Error('VERSION_CONFLICT')
      const change = await transaction.userPlanChange.create({ data: { userId: id, fromPlan, toPlan, reason, actorUserId: actor.userId }, select: { id: true, fromPlan: true, toPlan: true, createdAt: true } })
      const user = await transaction.user.findUnique({ where: { id }, select: USER_SELECT })
      if (!user) throw new Error('ADMIN_USER_NOT_FOUND')
      await transaction.adminAuditLog.create({ data: { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.user.plan', targetType: 'plan_change', targetId: change.id, tenantUserId: id, reason, outcome: 'success', before: { roleKey: fromPlan }, after: { roleKey: toPlan } } })
      return { status: 200, body: { user: toAdminUserDto(user), change: { id: change.id, fromPlan: change.fromPlan, toPlan: change.toPlan, createdAt: change.createdAt.toISOString() } } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) {
    if (error instanceof Error && error.message === 'VERSION_CONFLICT') return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId)
    return adminError(error, correlationId)
  }
}

function parseTimestamp(value: unknown): Date {
  if (typeof value !== 'string') throw new Error('updatedAt is required')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('updatedAt is invalid')
  return date
}
