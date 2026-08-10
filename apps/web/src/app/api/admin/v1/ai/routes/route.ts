import { db } from '@/lib/db'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { validateAiRoute } from '@/lib/admin/ai'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'

const ROUTE_SELECT = { id: true, featureKey: true, defaultProvider: true, defaultModel: true, fallbackProvider: true, fallbackModel: true, version: true, updatedById: true, updatedAt: true } as const

export async function GET(request: Request) {
  const correlationId = requestId(request)
  try { await requireAdminActor('ai_budget.read', request); const routes = await db.aiRouteConfig.findMany({ orderBy: { featureKey: 'asc' }, select: ROUTE_SELECT }); return adminJson({ items: routes }, 200, correlationId) } catch (error) { return adminError(error, correlationId) }
}

export async function PATCH(request: Request) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('ai_budget.update', request); const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const body = await jsonBody(request); const reason = requiredReason(body); const providers = await db.aiProviderConfig.findMany({ select: { key: true, enabled: true, models: { where: { active: true }, select: { model: true } } } }); const activeModels = new Set(providers.filter(provider => provider.enabled).flatMap(provider => provider.models.map(model => `${provider.key}/${model.model}`))); const value = validateAiRoute(body, activeModels); const version = body.version
    if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version) || version < 1)) throw new Error('Route version is invalid')
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.ai.route.update', body: { ...value, version, reason } }, async transaction => {
      const existing = await transaction.aiRouteConfig.findUnique({ where: { featureKey: value.featureKey }, select: ROUTE_SELECT })
      if (existing && version !== undefined && existing.version !== version) throw new Error('VERSION_CONFLICT')
      const route = existing ? await transaction.aiRouteConfig.update({ where: { id: existing.id }, data: { ...value, updatedById: actor.userId, version: { increment: 1 } }, select: ROUTE_SELECT }) : await transaction.aiRouteConfig.create({ data: { ...value, updatedById: actor.userId }, select: ROUTE_SELECT })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.ai.route.update', targetType: 'ai_route', targetId: route.id, reason, outcome: 'success', before: existing ? { roleKey: `${existing.defaultProvider}/${existing.defaultModel}`, version: existing.version } : undefined, after: { roleKey: `${route.defaultProvider}/${route.defaultModel}`, version: route.version } })
      return { status: 200, body: { route } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) { if (error instanceof Error && error.message === 'VERSION_CONFLICT') return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId); return adminError(error, correlationId) }
}
