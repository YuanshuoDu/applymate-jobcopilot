import { db } from '@/lib/db'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { runtimeCredentialConfigured, toAiProviderDto, validateAiProvider } from '@/lib/admin/ai'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'
import { AI_PROVIDER_SELECT } from '@/lib/admin/ai'

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('ai_budget.update', request)
    const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { id } = await context.params; const body = await jsonBody(request); const reason = requiredReason(body); const value = validateAiProvider(body); const version = body.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new Error('Provider version is required')
    const current = await db.aiProviderConfig.findUnique({ where: { id }, select: AI_PROVIDER_SELECT }); if (!current) return adminJson({ error: 'AI_PROVIDER_NOT_FOUND' }, 404, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.ai.provider.update', body: { id, ...value, version, reason } }, async transaction => {
      const updated = await transaction.aiProviderConfig.update({ where: { id: current.id, version }, data: { ...value, version: { increment: 1 } }, select: AI_PROVIDER_SELECT })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.ai.provider.update', targetType: 'ai_provider', targetId: updated.id, reason, outcome: 'success', before: { roleKey: current.key, version: current.version }, after: { roleKey: updated.key, status: updated.enabled ? 'enabled' : 'disabled', version: updated.version, secretRef: updated.secretRef ?? null } })
      return { status: 200, body: { provider: toAiProviderDto({ ...updated, credentialConfigured: runtimeCredentialConfigured(updated) }) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) { if (isConflict(error)) return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId); return adminError(error, correlationId) }
}

function isConflict(value: unknown): boolean { return Boolean(value && typeof value === 'object' && (value as { code?: unknown }).code === 'P2025') }
