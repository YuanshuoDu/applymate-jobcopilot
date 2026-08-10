import { db } from '@/lib/db'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { toAiModelDto, validateAiModel } from '@/lib/admin/ai'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'
import { MODEL_SELECT } from '@/lib/admin/ai'

export async function PATCH(request: Request, context: { params: Promise<{ id: string; modelId: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('ai_budget.update', request); const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { id: providerId, modelId } = await context.params; const body = await jsonBody(request); const reason = requiredReason(body); const value = validateAiModel(body); const current = await db.aiModelConfig.findFirst({ where: { id: modelId, providerId }, select: MODEL_SELECT }); if (!current) return adminJson({ error: 'AI_MODEL_NOT_FOUND' }, 404, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.ai.model.update', body: { modelId, providerId, ...value, reason } }, async transaction => {
      const updated = await transaction.aiModelConfig.update({ where: { id: current.id }, data: value, select: MODEL_SELECT })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.ai.model.update', targetType: 'ai_model', targetId: updated.id, reason, outcome: 'success', before: { roleKey: current.model, status: current.active ? 'active' : 'inactive' }, after: { roleKey: updated.model, status: updated.active ? 'active' : 'inactive' } })
      return { status: 200, body: { model: toAiModelDto(updated) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}
