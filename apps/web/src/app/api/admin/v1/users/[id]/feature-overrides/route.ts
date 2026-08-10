import { db } from '@/lib/db'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { validateFeatureOverride } from '@/lib/admin/plans'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'

const OVERRIDE_SELECT = { id: true, featureKey: true, enabled: true, limit: true, expiresAt: true, reason: true, updatedAt: true } as const

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    await requireAdminActor('users.read', request)
    const { id } = await context.params
    const user = await db.user.findUnique({ where: { id }, select: { id: true } })
    if (!user) return adminJson({ error: 'ADMIN_USER_NOT_FOUND' }, 404, correlationId)
    const overrides = await db.userFeatureOverride.findMany({ where: { userId: id }, orderBy: { featureKey: 'asc' }, select: OVERRIDE_SELECT })
    return adminJson({ items: overrides.map(toOverrideDto) }, 200, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('billing.update', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { id } = await context.params
    const body = await jsonBody(request)
    const reason = requiredReason(body)
    const value = validateFeatureOverride(body)
    const user = await db.user.findUnique({ where: { id }, select: { id: true } })
    if (!user) return adminJson({ error: 'ADMIN_USER_NOT_FOUND' }, 404, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.user.feature_override', body: { id, ...value, reason } }, async transaction => {
      const override = await transaction.userFeatureOverride.upsert({
        where: { userId_featureKey: { userId: id, featureKey: value.featureKey } },
        create: { userId: id, featureKey: value.featureKey, enabled: value.enabled, limit: value.limit ?? null, expiresAt: value.expiresAt ?? null, reason, actorUserId: actor.userId },
        update: { enabled: value.enabled, limit: value.limit ?? null, expiresAt: value.expiresAt ?? null, reason, actorUserId: actor.userId },
        select: OVERRIDE_SELECT,
      })
      await transaction.adminAuditLog.create({ data: { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.user.feature_override', targetType: 'user', targetId: id, tenantUserId: id, reason, outcome: 'success', after: { roleKey: override.featureKey, status: override.enabled ? 'enabled' : 'disabled', version: override.limit ?? 0 } } })
      return { status: 200, body: { override: toOverrideDto(override) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}

function toOverrideDto(input: unknown) {
  const row = input as { id?: unknown; featureKey?: unknown; enabled?: unknown; limit?: unknown; expiresAt?: unknown; reason?: unknown; updatedAt?: unknown }
  return {
    id: typeof row.id === 'string' ? row.id : '', featureKey: typeof row.featureKey === 'string' ? row.featureKey : '', enabled: row.enabled === true,
    limit: typeof row.limit === 'number' ? row.limit : null, expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : null,
    reason: typeof row.reason === 'string' ? row.reason.slice(0, 500) : '', updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
  }
}
