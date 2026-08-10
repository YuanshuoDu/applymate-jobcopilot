import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { planKey, validateEntitlement } from '@/lib/admin/plans'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'

type Params = { params: Promise<{ plan: string }> }

export async function GET(request: Request, context: Params) {
  const correlationId = requestId(request)
  try {
    await requireAdminActor('billing.read', request)
    const plan = planKey((await context.params).plan)
    const catalogue = await db.planCatalogue.findUnique({ where: { plan }, select: { entitlements: true, version: true } })
    if (!catalogue) return adminJson({ error: 'PLAN_NOT_FOUND' }, 404, correlationId)
    return adminJson({ items: toItems(catalogue.entitlements), version: catalogue.version }, 200, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}

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
    if (!Array.isArray(body.entitlements)) throw new Error('Entitlements must be an array')
    const values = body.entitlements.map(validateEntitlement)
    const encoded = values.filter(value => value.enabled).map(encodeEntitlement)
    const current = await db.planCatalogue.findUnique({ where: { plan }, select: { id: true, plan: true, version: true, entitlements: true } })
    if (!current) return adminJson({ error: 'PLAN_NOT_FOUND' }, 404, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.plan.entitlements', body: { plan, values, version, reason } }, async transaction => {
      const result = await transaction.planCatalogue.updateMany({ where: { id: current.id, version }, data: { entitlements: encoded as unknown as Prisma.InputJsonValue, version: { increment: 1 } } })
      if (result.count !== 1) throw new VersionConflictError()
      const updated = await transaction.planCatalogue.findUniqueOrThrow({ where: { id: current.id }, select: { entitlements: true, version: true } })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.plan.entitlements', targetType: 'plan', targetId: current.id, reason, outcome: 'success', before: { roleKey: plan, version }, after: { roleKey: plan, permissionCount: encoded.length, version: updated.version } })
      return { status: 200, body: { items: toItems(updated.entitlements), version: updated.version } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) {
    if (error instanceof VersionConflictError) return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId)
    return adminError(error, correlationId)
  }
}

function toItems(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const decoded = decodeEntitlement(item)
    return decoded ? [{ id: `entitlement_${index + 1}`, ...decoded }] : []
  })
}

function encodeEntitlement(value: ReturnType<typeof validateEntitlement>): string {
  if (value.kind === 'limit') return `${value.featureKey}:${value.limit}`
  if (value.kind === 'text') return `${value.featureKey}:${value.textValue}`
  return value.featureKey
}

function decodeEntitlement(value: unknown): ReturnType<typeof validateEntitlement> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    try { return validateEntitlement(value) } catch { return null }
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const separator = value.indexOf(':')
  const featureKey = separator < 0 ? value : value.slice(0, separator)
  const suffix = separator < 0 ? '' : value.slice(separator + 1)
  try {
    if (!suffix) return validateEntitlement({ featureKey, kind: 'boolean', enabled: true })
    if (/^\d+(?:\/.*)?$/.test(suffix)) return validateEntitlement({ featureKey, kind: 'limit', enabled: true, limit: Number(suffix.split('/')[0]) })
    return validateEntitlement({ featureKey, kind: 'text', enabled: true, textValue: suffix })
  } catch { return null }
}

class VersionConflictError extends Error {}
