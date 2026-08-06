import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { toAdminMemberDto } from '@/lib/admin/dto'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason } from '@/lib/admin/route-utils'

const MEMBER_SELECT = {
  id: true, userId: true, status: true, mfaLevel: true, sessionVersion: true, grantedAt: true,
  role: { select: { key: true, name: true, permissions: true } },
  user: { select: { id: true, email: true, name: true, plan: true } },
} as const

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const { id } = await context.params
    const actor = await requireAdmin('admin_members.manage', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const body = await jsonBody(request)
    const reason = requiredReason(body)
    const version = body.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new Error('Membership version is required')
    const current = await db.adminMembership.findUnique({ where: { id }, select: { ...MEMBER_SELECT, roleId: true } })
    if (!current) return adminJson({ error: 'ADMIN_MEMBER_NOT_FOUND' }, 404, correlationId)
    const nextStatus = body.status === undefined ? current.status : parseStatus(body.status)
    const nextRoleId = body.roleId === undefined ? current.roleId : requiredString(body.roleId, 'roleId')
    if (current.userId === actor.userId && (nextStatus !== 'active' || nextRoleId !== current.roleId)) {
      return adminJson({ error: 'SELF_ADMIN_CHANGE_FORBIDDEN' }, 403, correlationId)
    }
    const targetRole = nextRoleId === current.roleId
      ? { id: current.roleId, key: current.role.key }
      : await db.adminRole.findUnique({ where: { id: nextRoleId }, select: { id: true, key: true } })
    if (!targetRole) return adminJson({ error: 'ADMIN_ROLE_NOT_FOUND' }, 404, correlationId)
    if (current.role.key === 'super_admin' && current.status === 'active' && (targetRole.key !== 'super_admin' || nextStatus !== 'active')) {
      const standing = await db.adminMembership.count({ where: { roleId: current.roleId, status: 'active' } })
      if (standing <= 1) return adminJson({ error: 'LAST_SUPER_ADMIN_PROTECTED' }, 409, correlationId)
    }
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, {
      actorUserId: actor.userId, key: idempotencyKey, action: 'admin.member.update', body: { id: current.id, roleId: nextRoleId, status: nextStatus, version, reason },
    }, async transaction => {
      const member = await transaction.adminMembership.update({
        where: { id: current.id, sessionVersion: version },
        data: { roleId: nextRoleId, status: nextStatus, revokedAt: nextStatus === 'revoked' ? new Date() : null },
        select: MEMBER_SELECT,
      })
      await writeAdminAudit(transaction, {
        requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey,
        action: 'admin.member.update', targetType: 'admin_member', targetId: member.id, reason, outcome: 'success',
        before: { status: current.status, roleKey: current.role.key, sessionVersion: current.sessionVersion },
        after: { status: member.status, roleKey: member.role.key, sessionVersion: member.sessionVersion },
      })
      return { status: 200, body: { member: toAdminMemberDto(member) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) {
    if (isPrismaConflict(error)) return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId)
    return adminError(error, correlationId)
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function parseStatus(value: unknown): 'active' | 'suspended' | 'revoked' {
  if (value === 'active' || value === 'suspended' || value === 'revoked') return value
  throw new Error('Invalid membership status')
}

function isPrismaConflict(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { code?: unknown }).code === 'P2025')
}
