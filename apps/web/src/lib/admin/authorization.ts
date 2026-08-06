import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { safeAuth } from '@/lib/safe-auth'
import { writeAdminAudit } from './audit'
import { ADMIN_PERMISSION_KEYS, type Permission } from './permissions'

export interface AdminActor {
  userId: string
  email?: string
  membershipId: string
  roleKey: string
  permissions: Permission[]
  mfaLevel: string
  sessionVersion: number
}

export class AdminAuthorizationError extends Error {
  constructor(readonly status: 401 | 403, readonly code: string) {
    super(code)
  }
}

export async function requireAdmin(permission: Permission, request?: Request): Promise<AdminActor> {
  const requestId = request?.headers.get('x-request-id') || randomUUID()
  const session = await safeAuth()
  const userId = session?.user?.id
  if (!userId) throw new AdminAuthorizationError(401, 'ADMIN_UNAUTHENTICATED')

  const membership = await db.adminMembership.findUnique({
    where: { userId },
    select: {
      id: true,
      status: true,
      mfaLevel: true,
      sessionVersion: true,
      role: { select: { key: true, permissions: true } },
    },
  })

  if (!membership) {
    await auditDenied(requestId, userId, 'ADMIN_MEMBERSHIP_REQUIRED')
    throw new AdminAuthorizationError(403, 'ADMIN_MEMBERSHIP_REQUIRED')
  }
  if (membership.status !== 'active') {
    await auditDenied(requestId, userId, 'ADMIN_MEMBERSHIP_INACTIVE')
    throw new AdminAuthorizationError(403, 'ADMIN_MEMBERSHIP_INACTIVE')
  }

  const sessionVersion = session.user.adminSessionVersion
  if (typeof sessionVersion !== 'number') {
    await auditDenied(requestId, userId, 'ADMIN_SESSION_VERSION_MISSING')
    throw new AdminAuthorizationError(403, 'ADMIN_SESSION_VERSION_MISSING')
  }
  if (sessionVersion !== membership.sessionVersion) {
    await auditDenied(requestId, userId, 'ADMIN_SESSION_REVOKED')
    throw new AdminAuthorizationError(403, 'ADMIN_SESSION_REVOKED')
  }

  if (!(ADMIN_PERMISSION_KEYS as readonly string[]).includes(permission)) {
    await auditDenied(requestId, userId, 'ADMIN_PERMISSION_UNKNOWN')
    throw new AdminAuthorizationError(403, 'ADMIN_PERMISSION_UNKNOWN')
  }

  const permissions = membership.role.permissions.filter(
    (value): value is Permission => (ADMIN_PERMISSION_KEYS as readonly string[]).includes(value),
  )
  if (!permissions.includes(permission)) {
    await auditDenied(requestId, userId, 'ADMIN_PERMISSION_DENIED', membership.role.key)
    throw new AdminAuthorizationError(403, 'ADMIN_PERMISSION_DENIED')
  }

  return Object.freeze({
    userId,
    email: session.user.email ?? undefined,
    membershipId: membership.id,
    roleKey: membership.role.key,
    permissions,
    mfaLevel: membership.mfaLevel,
    sessionVersion,
  })
}

async function auditDenied(requestId: string, userId: string, code: string, roleKey?: string): Promise<void> {
  try {
    await writeAdminAudit(db, {
      requestId,
      actorUserId: userId,
      actorRoleKey: roleKey,
      action: 'admin.authorization.denied',
      outcome: 'denied',
      errorCode: code,
    })
  } catch {
    // Access denial remains fail-closed even if the audit store is unavailable.
  }
}
