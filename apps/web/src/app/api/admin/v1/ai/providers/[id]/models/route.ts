import { db } from '@/lib/db'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { MODEL_SELECT, toAiModelDto, validateAiModel } from '@/lib/admin/ai'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try { await requireAdminActor('ai_budget.read', request); const { id } = await context.params; const provider = await db.aiProviderConfig.findUnique({ where: { id }, select: { id: true } }); if (!provider) return adminJson({ error: 'AI_PROVIDER_NOT_FOUND' }, 404, correlationId); const models = await db.aiModelConfig.findMany({ where: { providerId: id }, orderBy: { model: 'asc' }, select: MODEL_SELECT }); return adminJson({ items: models.map(toAiModelDto) }, 200, correlationId) } catch (error) { return adminError(error, correlationId) }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('ai_budget.update', request); const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { id } = await context.params; const body = await jsonBody(request); const reason = requiredReason(body); const value = validateAiModel(body); const provider = await db.aiProviderConfig.findUnique({ where: { id }, select: { id: true, key: true } }); if (!provider) return adminJson({ error: 'AI_PROVIDER_NOT_FOUND' }, 404, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.ai.model.create', body: { providerId: id, ...value, reason } }, async transaction => {
      const model = await transaction.aiModelConfig.create({ data: { providerId: id, ...value }, select: MODEL_SELECT })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.ai.model.create', targetType: 'ai_model', targetId: model.id, reason, outcome: 'success', after: { roleKey: `${provider.key}/${model.model}`, status: model.active ? 'active' : 'inactive' } })
      return { status: 201, body: { model: toAiModelDto(model) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}
