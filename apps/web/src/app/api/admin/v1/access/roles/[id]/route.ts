import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { canEditRole, validatePermissionList } from '@/lib/admin/permissions'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason } from '@/lib/admin/route-utils'
import { toAdminRoleDto } from '@/lib/admin/dto'

const ROLE_SELECT = { id: true, key: true, name: true, permissions: true, system: true, version: true } as const

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const { id } = await context.params
    const actor = await requireAdmin('admin_roles.manage', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const body = await jsonBody(request)
    const reason = requiredReason(body)
    const version = body.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new Error('Role version is required')
    const current = await db.adminRole.findUnique({ where: { id }, select: ROLE_SELECT })
    if (!current) return adminJson({ error: 'ADMIN_ROLE_NOT_FOUND' }, 404, correlationId)
    const permissionsResult = canEditRole(
      { roleKey: actor.roleKey, permissions: actor.permissions },
      { key: current.key, isLastSuperAdmin: current.key === 'super_admin' && await activeSuperAdminCount(current.id) <= 1 },
      body.permissions ?? current.permissions,
    )
    if (!permissionsResult.ok) return adminJson({ error: permissionsResult.error }, 403, correlationId)
    const permissions = permissionsResult.permissions
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, {
      actorUserId: actor.userId, key: idempotencyKey, action: 'admin.role.update', body: { id: current.id, name: body.name, permissions, version, reason },
    }, async transaction => {
      const role = await transaction.adminRole.update({
        where: { id: current.id, version },
        data: { name: typeof body.name === 'string' ? body.name.trim().slice(0, 100) : current.name, description: typeof body.description === 'string' ? body.description.trim().slice(0, 500) : undefined, permissions, version: { increment: 1 } },
        select: ROLE_SELECT,
      })
      await writeAdminAudit(transaction, {
        requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey,
        action: 'admin.role.update', targetType: 'admin_role', targetId: role.id, reason, outcome: 'success',
        before: { roleKey: current.key, roleName: current.name, permissionCount: current.permissions.length, version: current.version },
        after: { roleKey: role.key, roleName: role.name, permissionCount: role.permissions.length, version: role.version },
      })
      return { status: 200, body: { role: toAdminRoleDto(role) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) {
    if (isPrismaConflict(error)) return adminJson({ error: 'VERSION_CONFLICT' }, 409, correlationId)
    return adminError(error, correlationId)
  }
}

async function activeSuperAdminCount(roleId: string): Promise<number> {
  return db.adminMembership.count({ where: { roleId, status: 'active' } })
}

function isPrismaConflict(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { code?: unknown }).code === 'P2025')
}
