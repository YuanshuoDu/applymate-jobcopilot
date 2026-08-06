import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { planKey, toPlanCatalogDto, validatePlanMetadata } from '@/lib/admin/plans'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason } from '@/lib/admin/route-utils'
import { PLAN_SELECT } from '../route'

export async function PATCH(request: Request, context: { params: Promise<{ plan: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdmin('billing.update', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { plan: rawPlan } = await context.params
    const plan = planKey(rawPlan)
    const body = await jsonBody(request)
    const reason = requiredReason(body)
    const version = body.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new Error('Plan version is required')
    const metadata = validatePlanMetadata(body)
    if (typeof body.active !== 'boolean') throw new Error('Plan active flag is required')
    const active = body.active
    const current = await db.planCatalog.findUnique({ where: { plan }, select: PLAN_SELECT })
    if (!current) return adminJson({ error: 'PLAN_NOT_FOUND' }, 404, correlationId)
    if (current.active && !active && await db.planTransition.count({ where: { toPlan: plan, enabled: true } }) > 0) return adminJson({ error: 'PLAN_HAS_ENABLED_TRANSITIONS' }, 409, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.plan.update', body: { plan, ...metadata, active, version, reason } }, async transaction => {
      const updated = await transaction.planCatalog.update({ where: { id: current.id, version }, data: { ...metadata, active, version: { increment: 1 } }, select: PLAN_SELECT })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.plan.update', targetType: 'plan', targetId: updated.id, reason, outcome: 'success', before: { roleKey: current.plan, roleName: current.name, version: current.version }, after: { roleKey: updated.plan, roleName: updated.name, version: updated.version } })
      return { status: 200, body: { plan: toPlanCatalogDto(updated) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) {
    if (isConflict(error)) return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId)
    return adminError(error, correlationId)
  }
}

function isConflict(value: unknown): boolean { return Boolean(value && typeof value === 'object' && (value as { code?: unknown }).code === 'P2025') }
