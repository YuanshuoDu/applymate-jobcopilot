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
    const actor = await requireAdmin('support_cases.reply', request); const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { id } = await context.params; const body = await jsonBody(request); const reason = requiredReason(body); const sanitized = sanitizeSupportMessage(body.message); const supportCase = await db.supportCase.findUnique({ where: { id }, select: { id: true, requesterUserId: true, firstRespondedAt: true } }); if (!supportCase) return adminJson({ error: 'SUPPORT_CASE_NOT_FOUND' }, 404, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.support.reply', body: { id, message: sanitized.text, reason } }, async transaction => {
      const message = await transaction.supportCaseMessage.create({ data: { caseId: id, authorType: 'staff_reply', authorUserId: actor.userId, body: sanitized.text, redacted: sanitized.redacted }, select: { id: true } })
      await transaction.supportCase.update({ where: { id }, data: { status: 'in_progress', ...(supportCase.firstRespondedAt ? {} : { firstRespondedAt: new Date() }) } })
      await transaction.notification.create({ data: { userId: supportCase.requesterUserId, type: 'contact_us_reply', title: 'Support replied to your request', body: 'A support agent has replied in Contact us.' } })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'support.reply_sent', targetType: 'support_case', targetId: id, tenantUserId: supportCase.requesterUserId, reason, outcome: 'success', after: { messageId: message.id, redacted: sanitized.redacted } })
      return { status: 201, body: { messageId: message.id, redacted: sanitized.redacted } }
    }); return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}
