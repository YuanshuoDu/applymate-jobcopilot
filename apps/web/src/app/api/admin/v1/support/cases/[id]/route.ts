import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { parseSupportCasePriority, parseSupportCaseStatus, supportStatusTransition } from '@/lib/admin/support'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason } from '@/lib/admin/route-utils'

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdmin('support_cases.assign', request); const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { id } = await context.params; const body = await jsonBody(request); const reason = requiredReason(body); const current = await db.supportCase.findUnique({ where: { id }, select: { id: true, status: true, priority: true, assignedAdminId: true, firstRespondedAt: true, updatedAt: true } }); if (!current) return adminJson({ error: 'SUPPORT_CASE_NOT_FOUND' }, 404, correlationId)
    if (typeof body.updatedAt !== 'string' || Number.isNaN(new Date(body.updatedAt).getTime())) throw new Error('updatedAt is required')
    const nextStatus = body.status === undefined ? current.status : parseSupportCaseStatus(body.status); const nextPriority = body.priority === undefined ? current.priority : parseSupportCasePriority(body.priority); const assignedAdminId = body.assignedAdminId === null || typeof body.assignedAdminId === 'string' ? body.assignedAdminId : current.assignedAdminId
    if (!nextStatus || !supportStatusTransition(current.status, nextStatus) && nextStatus !== current.status) return adminJson({ error: 'SUPPORT_STATUS_TRANSITION_INVALID' }, 409, correlationId)
    if (!nextPriority) return adminJson({ error: 'SUPPORT_PRIORITY_INVALID' }, 400, correlationId)
    if (assignedAdminId) { const member = await db.adminMembership.findFirst({ where: { userId: assignedAdminId, status: 'active' }, select: { userId: true } }); if (!member) return adminJson({ error: 'SUPPORT_ASSIGNEE_INVALID' }, 400, correlationId) }
    const idempotencyKey = requiredIdempotencyKey(request); const updatedAt = new Date(body.updatedAt)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.support.case.update', body: { id, nextStatus, nextPriority, assignedAdminId, updatedAt: updatedAt.toISOString(), reason } }, async transaction => {
      const updated = await transaction.supportCase.updateMany({ where: { id, updatedAt }, data: { status: nextStatus, priority: nextPriority, assignedAdminId, ...(nextStatus === 'resolved' ? { resolvedAt: new Date() } : {}), ...(current.firstRespondedAt === null && nextStatus === 'in_progress' ? { firstRespondedAt: new Date() } : {}) } }); if (updated.count !== 1) throw new Error('VERSION_CONFLICT')
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: assignedAdminId !== current.assignedAdminId ? 'support.case.assigned' : nextStatus === 'resolved' ? 'support.case.resolved' : 'support.case.updated', targetType: 'support_case', targetId: id, reason, outcome: 'success', after: { status: nextStatus, priority: nextPriority, assignedAdminId } })
      return { status: 200, body: { updated: true } }
    }); return adminJson(response.body, response.status, correlationId)
  } catch (error) { if (error instanceof Error && error.message === 'VERSION_CONFLICT') return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId); return adminError(error, correlationId) }
}
