import { NextResponse } from 'next/server'
import { AdminMfaLevel, AdminMembershipStatus } from '@prisma/client'
import { safeAuth } from '@/lib/safe-auth'
import { db } from '@/lib/db'
import { requestIdFor, writeAdminAudit } from './audit'
import { validateAdminWrite } from './csrf'
import { hasFreshAdminReauth } from './webauthn'
import type { Permission } from './permissions'
import { isAdminHost, isLocalHost } from '@/lib/host-routing'

export type AdminActor = Readonly<{
  userId: string
  roleKey: string
  permissions: readonly string[]
  requestId: string
}>

const highRiskPermissions = new Set([
  'admin_members.manage', 'admin_roles.manage', 'sessions.revoke',
  'users.suspend', 'users.restore', 'users.activate', 'users.export_anonymized', 'users.feature_override', 'billing.update',
  'ai_budget.update', 'ai_budget.reset', 'feature_flags.update', 'feature_flags.approve',
  'ats.update', 'ats.pause', 'ats.resume', 'queues.pause', 'queues.resume', 'queues.retry',
  'broadcasts.create', 'broadcasts.publish', 'broadcasts.schedule', 'broadcasts.retry',
  'break_glass.request', 'break_glass.approve', 'support_cases.assign', 'support_cases.resolve',
  'support_cases.reply', 'support_cases.note', 'support_cases.escalate', 'support_macros.manage',
  'support_sla.manage', 'admin_access_reviews.manage', 'security.webauthn.manage', 'users.deletion.manage', 'users.api_keys.revoke',
  'observability.alerts.manage', 'incidents.manage',
])

export async function requireAdminMembership(request?: Request): Promise<AdminActor | NextResponse> {
  const requestId = requestIdFor(request)
  if (request && !isAdminRequest(request)) return administratorHostOnly()
  const session = await safeAuth()
  const userId = session?.user?.id
  if (!userId) return denied(requestId, 'observability.read', 'unauthenticated', request)
  const membership = await db.adminMembership.findUnique({
    where: { userId },
    select: { status: true, mfaLevel: true, sessionVersion: true, user: { select: { accountStatus: true } }, role: { select: { key: true, permissions: true } } },
  })
  const sessionValid = session?.user?.adminSessionVersion === membership?.sessionVersion
  if (membership?.user.accountStatus !== 'active' || membership?.status !== AdminMembershipStatus.active || !sessionValid || (membership.role.key === 'super_admin' && membership.mfaLevel !== AdminMfaLevel.webauthn)) {
    return denied(requestId, 'observability.read', 'membership_inactive', request, userId)
  }
  return Object.freeze({ userId, roleKey: membership.role.key, permissions: Object.freeze([...membership.role.permissions]), requestId })
}

export function requireAdmin(permission: Permission, request?: Request): Promise<AdminActor | NextResponse>
export async function requireAdmin(permission: Permission, request?: Request): Promise<AdminActor | NextResponse> {
  return requireAdminAny([permission], request)
}

export async function requireAdminAny(permissions: readonly Permission[], request?: Request): Promise<AdminActor | NextResponse> {
  const permission = permissions[0] ?? 'observability.read'
  if (request && !isAdminRequest(request)) return administratorHostOnly()
  if (request && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    const writeError = validateAdminWrite(request)
    if (writeError) return writeError
  }
  const requestId = requestIdFor(request)
  const session = await safeAuth()
  const userId = session?.user?.id
  if (!userId) return denied(requestId, permission, 'unauthenticated', request)

  const membership = await db.adminMembership.findUnique({
    where: { userId },
    select: {
      status: true,
      mfaLevel: true,
      sessionVersion: true,
      user: { select: { accountStatus: true } },
      role: { select: { key: true, permissions: true } },
    },
  })
  const activeAccount = membership?.user.accountStatus === 'active'
  const rolePermission = permissions.find(value => membership?.role.permissions.includes(value))
  const grant = activeAccount && membership?.status === AdminMembershipStatus.active && !rolePermission
    ? await db.adminBreakGlassGrant.findFirst({ where: { requesterId: userId, permission: { in: [...permissions] }, approverId: { not: null }, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, permission: true } })
    : null
  const allowed = activeAccount && membership?.status === AdminMembershipStatus.active && (Boolean(rolePermission) || Boolean(grant))
  const needsWebauthn = membership?.role.key === 'super_admin'
  const sessionValid = session?.user?.adminSessionVersion === membership?.sessionVersion
  const reauthValid = !permissions.some(value => highRiskPermissions.has(value)) || await hasFreshAdminReauth(request, userId)
  if (!allowed || !sessionValid || (needsWebauthn && membership?.mfaLevel !== AdminMfaLevel.webauthn) || !reauthValid) {
    return denied(requestId, permission, reauthValid ? 'permission_denied' : 'reauth_required', request, userId)
  }

  if (grant) await writeAdminAudit({ requestId, actorUserId: userId, actorRoleKey: membership.role.key, action: 'break_glass.used', targetId: grant.id, outcome: 'success' })
  return Object.freeze({ userId, roleKey: membership.role.key, permissions: Object.freeze([...membership.role.permissions, ...(grant ? [grant.permission ?? permission] : [])]), requestId })
}

function isAdminRequest(request: Request): boolean {
  try {
    const hostname = new URL(request.url).hostname
    return isAdminHost(hostname) || isLocalHost(hostname)
  } catch {
    return false
  }
}

function administratorHostOnly(): NextResponse {
  return NextResponse.json(
    { error: 'Administrator API is only available on the administrator host' },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  )
}

async function denied(requestId: string, permission: Permission, errorCode: string, request?: Request, userId?: string) {
  try {
    await writeAdminAudit({
      requestId,
      actorUserId: userId,
      action: `admin.authorize.${permission}`,
      outcome: 'denied',
      errorCode,
      ip: request?.headers.get('x-forwarded-for'),
      userAgent: request?.headers.get('user-agent'),
    })
  } catch {
    // A denial must never become an authorization grant when auditing is unavailable.
  }
  return NextResponse.json({ error: errorCode === 'reauth_required' ? 'Fresh WebAuthn authentication required' : 'Forbidden', code: errorCode, requestId }, { status: userId ? 403 : 401, headers: { 'Cache-Control': 'no-store' } })
}

export function isAdminResponse(value: AdminActor | NextResponse): value is NextResponse {
  return value instanceof NextResponse
}
