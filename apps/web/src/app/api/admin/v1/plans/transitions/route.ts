import { db } from '@/lib/db'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { planKey, toTransitionDto, validatePlanTransition, type PlanKey } from '@/lib/admin/plans'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'

const TRANSITION_SELECT = { id: true, fromPlan: true, toPlan: true, enabled: true, note: true, version: true } as const

export async function GET(request: Request) {
  const correlationId = requestId(request)
  try {
    await requireAdminActor('billing.read', request)
    const transitions = await db.planTransition.findMany({ orderBy: [{ fromPlan: 'asc' }, { toPlan: 'asc' }], select: TRANSITION_SELECT })
    return adminJson({ items: transitions.map(toTransitionDto) }, 200, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}

export async function PATCH(request: Request) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('billing.update', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const body = await jsonBody(request)
    const reason = requiredReason(body)
    const activeRows = await db.planCatalogue.findMany({ select: { plan: true, active: true } })
    const activePlans = new Set<PlanKey>(activeRows.filter(row => row.active).map(row => planKey(row.plan)))
    const value = validatePlanTransition(body, activePlans)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.plan.transition', body: { ...value, reason } }, async transaction => {
      const transition = await transaction.planTransition.upsert({
        where: { fromPlan_toPlan: { fromPlan: value.fromPlan, toPlan: value.toPlan } },
        create: { ...value },
        update: { enabled: value.enabled, note: value.note, version: { increment: 1 } },
        select: TRANSITION_SELECT,
      })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.plan.transition', targetType: 'plan', targetId: transition.id, reason, outcome: 'success', after: { roleKey: `${transition.fromPlan}->${transition.toPlan}`, status: transition.enabled ? 'enabled' : 'disabled', version: transition.version } })
      return { status: 200, body: { transition: toTransitionDto(transition) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}
