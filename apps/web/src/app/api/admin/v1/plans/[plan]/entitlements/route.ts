import { db } from '@/lib/db'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { planKey, toEntitlementDto, validateEntitlement } from '@/lib/admin/plans'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'

const ENTITLEMENT_SELECT = { id: true, featureKey: true, kind: true, enabled: true, limit: true, textValue: true } as const

export async function GET(request: Request, context: { params: Promise<{ plan: string }> }) {
  const correlationId = requestId(request)
  try {
    await requireAdminActor('billing.read', request)
    const { plan: rawPlan } = await context.params
    const plan = planKey(rawPlan)
    const catalogue = await db.planCatalog.findUnique({ where: { plan }, select: { id: true } })
    if (!catalogue) return adminJson({ error: 'PLAN_NOT_FOUND' }, 404, correlationId)
    const entitlements = await db.planEntitlement.findMany({ where: { planId: catalogue.id }, orderBy: { featureKey: 'asc' }, select: ENTITLEMENT_SELECT })
    return adminJson({ items: entitlements.map(toEntitlementDto) }, 200, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}

export async function PATCH(request: Request, context: { params: Promise<{ plan: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('billing.update', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { plan: rawPlan } = await context.params
    const plan = planKey(rawPlan)
    const body = await jsonBody(request)
    const reason = requiredReason(body)
    const version = body.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new Error('Plan version is required')
    if (!Array.isArray(body.entitlements)) throw new Error('Entitlements must be an array')
    const values = body.entitlements.map(validateEntitlement)
    const current = await db.planCatalog.findUnique({ where: { plan }, select: { id: true, version: true } })
    if (!current) return adminJson({ error: 'PLAN_NOT_FOUND' }, 404, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.plan.entitlements', body: { plan, values, version, reason } }, async transaction => {
      await transaction.planCatalog.update({ where: { id: current.id, version }, data: { version: { increment: 1 } }, select: { id: true, version: true } })
      await transaction.planEntitlement.deleteMany({ where: { planId: current.id } })
      if (values.length) await transaction.planEntitlement.createMany({ data: values.map(value => ({ planId: current.id, ...value })) })
      const entitlements = await transaction.planEntitlement.findMany({ where: { planId: current.id }, orderBy: { featureKey: 'asc' }, select: ENTITLEMENT_SELECT })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.plan.entitlements', targetType: 'plan', targetId: current.id, reason, outcome: 'success', before: { roleKey: plan, version }, after: { roleKey: plan, permissionCount: entitlements.length, version: version + 1 } })
      return { status: 200, body: { items: entitlements.map(toEntitlementDto), version: version + 1 } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) {
    if (isConflict(error)) return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId)
    return adminError(error, correlationId)
  }
}

function isConflict(value: unknown): boolean { return Boolean(value && typeof value === 'object' && (value as { code?: unknown }).code === 'P2025') }
