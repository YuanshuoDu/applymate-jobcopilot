import { db } from '@/lib/db'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('broadcasts.update', request)
    const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { id } = await context.params; const body = await jsonBody(request); const reason = requiredReason(body)
    const current = await db.adminBroadcast.findUnique({ where: { id }, select: { id: true, status: true, createdById: true } })
    if (!current) return adminJson({ error: 'BROADCAST_NOT_FOUND' }, 404, correlationId)
    if (current.createdById !== actor.userId) return adminJson({ error: 'BROADCAST_ONLY_CREATOR_CAN_SUBMIT' }, 403, correlationId)
    if (current.status !== 'draft') return adminJson({ error: 'BROADCAST_STATUS_INVALID' }, 409, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.broadcast.submit', body: { id, reason } }, async transaction => {
      const broadcast = await transaction.adminBroadcast.update({ where: { id }, data: { status: 'pending_approval' }, select: { id: true, status: true } })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.broadcast.submit', targetType: 'broadcast', targetId: id, reason, outcome: 'success', after: { status: broadcast.status } })
      return { status: 200, body: { broadcast } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}
