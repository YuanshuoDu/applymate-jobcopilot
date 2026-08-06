import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason } from '@/lib/admin/route-utils'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdmin('support_cases.escalate', request); const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { id } = await context.params; const body = await jsonBody(request); const reason = requiredReason(body); const supportCase = await db.supportCase.findUnique({ where: { id }, select: { id: true, category: true, priority: true } }); if (!supportCase) return adminJson({ error: 'SUPPORT_CASE_NOT_FOUND' }, 404, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.support.escalate', body: { id, reason } }, async transaction => {
      await transaction.supportCaseMessage.create({ data: { caseId: id, authorType: 'system_event', authorUserId: actor.userId, body: 'Escalated to operations for review.', redacted: false } })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'support.case_escalated', targetType: 'support_case', targetId: id, reason, outcome: 'success', after: { category: supportCase.category, priority: supportCase.priority, destination: 'operations' } })
      return { status: 200, body: { escalated: true } }
    }); return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}
