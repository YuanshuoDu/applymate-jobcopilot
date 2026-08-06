import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { validatePermissionList } from '@/lib/admin/permissions'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason } from '@/lib/admin/route-utils'
import { toAdminRoleDto } from '@/lib/admin/dto'

const ROLE_SELECT = { id: true, key: true, name: true, permissions: true, system: true, version: true } as const

export async function GET(request: Request) {
  const correlationId = requestId(request)
  try {
    await requireAdmin('admin_members.read', request)
    const roles = await db.adminRole.findMany({ orderBy: { name: 'asc' }, select: ROLE_SELECT })
    return adminJson({ items: roles.map(toAdminRoleDto) }, 200, correlationId)
  } catch (error) {
    return adminError(error, correlationId)
  }
}

export async function POST(request: Request) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdmin('admin_roles.manage', request)
    const csrf = validateAdminWriteRequest(request)
    if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const body = await jsonBody(request)
    const reason = requiredReason(body)
    const key = stringField(body.key, 'key').toLowerCase()
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(key)) throw new Error('Role key is invalid')
    const name = stringField(body.name, 'name').slice(0, 100)
    const permissions = validatePermissionList(body.permissions)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, {
      actorUserId: actor.userId, key: idempotencyKey, action: 'admin.role.create', body: { key, name, permissions, reason },
    }, async transaction => {
      const role = await transaction.adminRole.create({
        data: { key, name, description: optionalString(body.description, 500), permissions, system: false },
        select: ROLE_SELECT,
      })
      await writeAdminAudit(transaction, {
        requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey,
        action: 'admin.role.create', targetType: 'admin_role', targetId: role.id, reason, outcome: 'success',
        after: { roleKey: role.key, roleName: role.name, permissionCount: role.permissions.length, version: role.version },
      })
      return { status: 201, body: { role: toAdminRoleDto(role) } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) {
    return adminError(error, correlationId)
  }
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
}
