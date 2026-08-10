import { NextRequest, NextResponse } from 'next/server'
import { AdminMembershipStatus } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'

const statuses = Object.values(AdminMembershipStatus)

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('admin_members.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { roleKey?: unknown; status?: unknown; sessionVersion?: unknown; reason?: unknown } | null
  const roleKey = typeof payload?.roleKey === 'string' ? payload.roleKey : ''
  const status = typeof payload?.status === 'string' && statuses.includes(payload.status as AdminMembershipStatus) ? payload.status as AdminMembershipStatus : null
  const sessionVersion = typeof payload?.sessionVersion === 'number' && Number.isInteger(payload.sessionVersion) ? payload.sessionVersion : -1
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!roleKey || !status || sessionVersion < 1 || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid access update' }, { status: 400 })
  const membership = await db.adminMembership.findUnique({ where: { id }, select: { userId: true } })
  const role = await db.adminRole.findUnique({ where: { key: roleKey }, select: { id: true } })
  if (!membership || !role) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (membership.userId === actor.userId) return NextResponse.json({ error: 'Administrators cannot change their own access' }, { status: 403 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'admin_members.updated', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'admin_member', targetId: id, tenantUserId: membership.userId, reason, outcome: 'success', after: { roleKey, status, sessionVersion: sessionVersion + 1 } }, mutate: (tx) => tx.adminMembership.updateMany({ where: { id, sessionVersion }, data: { roleId: role.id, status, sessionVersion: { increment: 1 }, revokedAt: status === 'active' ? null : new Date() } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const updated = result.value
  if (!updated.count) return NextResponse.json({ error: 'Access changed' }, { status: 409 })
  return NextResponse.json({ id, sessionVersion: sessionVersion + 1 }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
