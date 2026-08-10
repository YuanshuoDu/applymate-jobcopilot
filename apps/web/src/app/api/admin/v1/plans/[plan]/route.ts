import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { planKey } from '@/lib/admin/plans'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'

type Params = { params: Promise<{ plan: string }> }

export async function PATCH(request: Request, context: Params) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('billing.update', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const plan = planKey((await context.params).plan)
    const body = await jsonBody(request)
    const reason = requiredReason(body)
    const version = body.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new Error('Plan version is required')
    if (typeof body.active !== 'boolean') throw new Error('Plan active flag is required')

    const current = await db.planCatalogue.findUnique({ where: { plan } })
    if (!current) return adminJson({ error: 'PLAN_NOT_FOUND' }, 404, correlationId)
    if (current.active && !body.active && await db.planTransition.count({ where: { toPlan: plan, enabled: true } }) > 0) {
      return adminJson({ error: 'PLAN_HAS_ENABLED_TRANSITIONS' }, 409, correlationId)
    }

    const data: Prisma.PlanCatalogueUpdateManyMutationInput = {
      name: typeof body.name === 'string' ? body.name.trim() : current.name,
      description: typeof body.description === 'string' ? body.description.trim() : current.description,
      priceMinor: typeof body.priceMinor === 'number' ? body.priceMinor : typeof body.monthlyPriceCents === 'number' ? body.monthlyPriceCents : current.priceMinor,
      currency: typeof body.currency === 'string' ? body.currency.toUpperCase() : current.currency,
      interval: typeof body.interval === 'string' ? body.interval as 'forever' | 'month' | 'year' : current.interval,
      features: (Array.isArray(body.features) ? body.features : current.features) as unknown as Prisma.InputJsonValue,
      entitlements: (Array.isArray(body.entitlements) ? body.entitlements : current.entitlements) as unknown as Prisma.InputJsonValue,
      badge: body.badge === null || typeof body.badge === 'string' ? body.badge : current.badge,
      cta: typeof body.cta === 'string' ? body.cta.trim() : current.cta,
      trialDays: typeof body.trialDays === 'number' ? body.trialDays : current.trialDays,
      active: body.active,
      sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : current.sortOrder,
      version: { increment: 1 },
    }
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.plan.update', body: { plan, data, version, reason } }, async transaction => {
      const result = await transaction.planCatalogue.updateMany({ where: { id: current.id, version }, data })
      if (result.count !== 1) throw new VersionConflictError()
      const updated = await transaction.planCatalogue.findUniqueOrThrow({ where: { id: current.id } })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.plan.update', targetType: 'plan', targetId: updated.id, reason, outcome: 'success', before: { roleKey: current.plan, roleName: current.name, version: current.version }, after: { roleKey: updated.plan, roleName: updated.name, version: updated.version } })
      return { status: 200, body: { plan: updated } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) {
    if (error instanceof VersionConflictError) return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId)
    return adminError(error, correlationId)
  }
}

class VersionConflictError extends Error {}
