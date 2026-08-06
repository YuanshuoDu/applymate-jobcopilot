import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { PLAN_SELECT, planKey, toPlanCatalogDto, validatePlanMetadata } from '@/lib/admin/plans'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason } from '@/lib/admin/route-utils'

export async function GET(request: Request) {
  const correlationId = requestId(request)
  try {
    await requireAdmin('billing.read', request)
    const plans = await db.planCatalog.findMany({ orderBy: { plan: 'asc' }, select: PLAN_SELECT })
    return adminJson({ items: plans.map(toPlanCatalogDto) }, 200, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}

export async function POST(request: Request) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdmin('billing.update', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const body = await jsonBody(request)
    const reason = requiredReason(body)
    const plan = planKey(body.plan)
    const metadata = validatePlanMetadata(body)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.plan.create', body: { plan, ...metadata, reason } }, async transaction => {
      const created = await transaction.planCatalog.create({ data: { plan, ...metadata }, select: PLAN_SELECT })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.plan.create', targetType: 'plan', targetId: created.id, reason, outcome: 'success', after: { roleKey: created.plan, roleName: created.name, version: created.version } })
      return { status: 201, body: { plan: toPlanCatalogDto(created) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}
