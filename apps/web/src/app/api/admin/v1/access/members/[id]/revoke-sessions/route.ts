import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason } from '@/lib/admin/route-utils'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const { id } = await context.params
    const actor = await requireAdmin('sessions.revoke', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const body = await jsonBody(request)
    const reason = requiredReason(body)
    const idempotencyKey = requiredIdempotencyKey(request)
    const current = await db.adminMembership.findUnique({ where: { id }, select: { id: true, userId: true, sessionVersion: true, role: { select: { key: true } } } })
    if (!current) return adminJson({ error: 'ADMIN_MEMBER_NOT_FOUND' }, 404, correlationId)
    const response = await withAdminIdempotency(db, {
      actorUserId: actor.userId, key: idempotencyKey, action: 'admin.member.revoke_sessions', body: { id: current.id, reason },
    }, async transaction => {
      const member = await transaction.adminMembership.update({
        where: { id: current.id, sessionVersion: current.sessionVersion },
        data: { sessionVersion: { increment: 1 } },
        select: { id: true, sessionVersion: true },
      })
      await writeAdminAudit(transaction, {
        requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey,
        action: 'admin.member.revoke_sessions', targetType: 'admin_member', targetId: member.id, reason, outcome: 'success',
        before: { sessionVersion: current.sessionVersion, roleKey: current.role.key },
        after: { sessionVersion: member.sessionVersion, roleKey: current.role.key },
      })
      return { status: 200, body: { memberId: member.id, sessionVersion: member.sessionVersion } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) {
    if (isPrismaConflict(error)) return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId)
    return adminError(error, correlationId)
  }
}

function isPrismaConflict(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { code?: unknown }).code === 'P2025')
}
