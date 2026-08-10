import { NextRequest, NextResponse } from 'next/server'
import { UserAccountStatus } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { adminUserMetadataSelect, toAdminUserMetadata } from '@/lib/admin/dto'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { parseAccountState, reasonFrom } from '@/lib/admin/user-lifecycle'
import { db } from '@/lib/db'
import type { Permission } from '@/lib/admin/permissions'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const status = parseAccountState(body?.status)
  if (!status) return NextResponse.json({ error: 'status must be active or suspended' }, { status: 400 })
  const permission: Permission = status === UserAccountStatus.active ? 'users.restore' : 'users.suspend'
  const actor = await requireAdmin(permission, request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const reason = reasonFrom(body?.reason, 'reason')
  const idempotencyKey = request.headers.get('idempotency-key')
  if (typeof reason !== 'string' || !idempotencyKey) return NextResponse.json({ error: typeof reason === 'string' ? 'Idempotency-Key is required' : reason.error }, { status: 400 })

  const { id } = await params
  const existing = await db.user.findUnique({ where: { id }, select: { accountStatus: true, suspendedAt: true, suspensionReason: true } })
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: `users.account_${status}`,
    idempotencyKey,
    targetId: id,
    audit: {
      requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'user', targetId: id,
      tenantUserId: id, reason, outcome: 'success',
      before: { accountStatus: existing.accountStatus, suspendedAt: existing.suspendedAt, suspensionReason: existing.suspensionReason },
      after: { accountStatus: status, suspendedAt: status === 'suspended' ? 'now' : null, suspensionReason: status === 'suspended' ? reason : null },
    },
    mutate: async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: status === UserAccountStatus.suspended
          ? { accountStatus: status, suspendedAt: new Date(), suspendedById: actor.userId, suspensionReason: reason }
          : { accountStatus: status, suspendedAt: null, suspendedById: null, suspensionReason: null },
        select: adminUserMetadataSelect,
      })
      // Invalidate privileged sessions immediately. Background workers also
      // re-check accountStatus before opening a browser/submitting.
      await tx.adminMembership.updateMany({
        where: { userId: id },
        data: { sessionVersion: { increment: 1 }, ...(status === UserAccountStatus.suspended ? { status: 'suspended', revokedAt: new Date() } : {}) },
      })
      if (status === UserAccountStatus.suspended) {
        await tx.agentAutomation.updateMany({ where: { userId: id }, data: { enabled: false } })
        await tx.applicationTask.updateMany({
          where: { userId: id, status: { in: ['filling', 'waiting_for_authorization'] } },
          data: { status: 'waiting_for_user', checkpoint: 'account_suspended', error: 'Account suspended; external processing was stopped.' },
        })
      }
      return user
    },
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json({ user: toAdminUserMetadata(result.value) }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
