import { NextResponse } from 'next/server'
import { AdminMfaLevel, AdminMembershipStatus } from '@prisma/client'
import { safeAuth } from '@/lib/safe-auth'
import { db } from '@/lib/db'
import { requestIdFor, writeAdminAudit } from './audit'
import type { Permission } from './permissions'

export type AdminActor = Readonly<{
  userId: string
  roleKey: string
  permissions: readonly string[]
  requestId: string
}>

export async function requireAdminMembership(request?: Request): Promise<AdminActor | NextResponse> {
  const requestId = requestIdFor(request)
  const session = await safeAuth()
  const userId = session?.user?.id
  if (!userId) return denied(requestId, 'observability.read', 'unauthenticated', request)
  const membership = await db.adminMembership.findUnique({
    where: { userId },
    select: { status: true, mfaLevel: true, sessionVersion: true, role: { select: { key: true, permissions: true } } },
  })
  const sessionValid = session?.user?.adminSessionVersion === membership?.sessionVersion
  if (membership?.status !== AdminMembershipStatus.active || !sessionValid || (membership.role.key === 'super_admin' && membership.mfaLevel !== AdminMfaLevel.webauthn)) {
    return denied(requestId, 'observability.read', 'membership_inactive', request, userId)
  }
  return Object.freeze({ userId, roleKey: membership.role.key, permissions: Object.freeze([...membership.role.permissions]), requestId })
}

export async function requireAdmin(permission: Permission, request?: Request): Promise<AdminActor | NextResponse> {
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
      role: { select: { key: true, permissions: true } },
    },
  })
  const allowed = membership?.status === AdminMembershipStatus.active && membership.role.permissions.includes(permission)
  const needsWebauthn = membership?.role.key === 'super_admin'
  const sessionValid = session?.user?.adminSessionVersion === membership?.sessionVersion
  if (!allowed || !sessionValid || (needsWebauthn && membership?.mfaLevel !== AdminMfaLevel.webauthn)) {
    return denied(requestId, permission, 'permission_denied', request, userId)
  }

  return Object.freeze({ userId, roleKey: membership.role.key, permissions: Object.freeze([...membership.role.permissions]), requestId })
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
  return NextResponse.json({ error: 'Forbidden', requestId }, { status: userId ? 403 : 401, headers: { 'Cache-Control': 'no-store' } })
}

export function isAdminResponse(value: AdminActor | NextResponse): value is NextResponse {
  return value instanceof NextResponse
}
