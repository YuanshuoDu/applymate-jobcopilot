import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { sanitizeSupportMessage } from '@/lib/admin/support'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason } from '@/lib/admin/route-utils'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdmin('support_cases.note', request); const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { id } = await context.params; const body = await jsonBody(request); const reason = requiredReason(body); const sanitized = sanitizeSupportMessage(body.message); const supportCase = await db.supportCase.findUnique({ where: { id }, select: { id: true } }); if (!supportCase) return adminJson({ error: 'SUPPORT_CASE_NOT_FOUND' }, 404, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.support.note', body: { id, message: sanitized.text, reason } }, async transaction => {
      const message = await transaction.supportCaseMessage.create({ data: { caseId: id, authorType: 'internal_note', authorUserId: actor.userId, body: sanitized.text, redacted: sanitized.redacted }, select: { id: true } })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'support.internal_note_added', targetType: 'support_case', targetId: id, reason, outcome: 'success', after: { messageId: message.id, redacted: sanitized.redacted } })
      return { status: 201, body: { messageId: message.id, redacted: sanitized.redacted } }
    }); return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}
