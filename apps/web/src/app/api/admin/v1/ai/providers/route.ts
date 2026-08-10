import { db } from '@/lib/db'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { AI_PROVIDER_SELECT, runtimeCredentialConfigured, toAiProviderDto, validateAiProvider } from '@/lib/admin/ai'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'

export async function GET(request: Request) {
  const correlationId = requestId(request)
  try { await requireAdminActor('ai_budget.read', request); const providers = await db.aiProviderConfig.findMany({ orderBy: { key: 'asc' }, select: AI_PROVIDER_SELECT }); return adminJson({ items: providers.map(provider => toAiProviderDto({ ...provider, credentialConfigured: runtimeCredentialConfigured(provider) })) }, 200, correlationId) } catch (error) { return adminError(error, correlationId) }
}

export async function POST(request: Request) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('ai_budget.update', request)
    const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const body = await jsonBody(request); const reason = requiredReason(body); const value = validateAiProvider(body); const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.ai.provider.create', body: { ...value, reason } }, async transaction => {
      const provider = await transaction.aiProviderConfig.create({ data: { ...value, credentialConfigured: false }, select: AI_PROVIDER_SELECT })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.ai.provider.create', targetType: 'ai_provider', targetId: provider.id, reason, outcome: 'success', after: { roleKey: provider.key, status: provider.enabled ? 'enabled' : 'disabled', secretRef: provider.secretRef ?? null } })
      return { status: 201, body: { provider: toAiProviderDto({ ...provider, credentialConfigured: runtimeCredentialConfigured(provider) }) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}
