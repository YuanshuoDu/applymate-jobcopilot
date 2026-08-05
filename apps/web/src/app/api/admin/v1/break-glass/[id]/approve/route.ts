import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { claimAdminIdempotencyKey } from '@/lib/admin/idempotency'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('break_glass.approve', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid break-glass approval' }, { status: 400 })
  const grant = await db.adminBreakGlassGrant.findUnique({ where: { id }, select: { requesterId: true, expiresAt: true, approverId: true, permission: true } })
  if (!grant) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (grant.requesterId === actor.userId) return NextResponse.json({ error: 'Requester cannot approve their own grant' }, { status: 403 })
  if (!await claimAdminIdempotencyKey(actor.userId, 'break_glass.approved', key, id)) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  if (grant.expiresAt <= new Date() || grant.approverId) return NextResponse.json({ error: 'Grant expired or was already approved' }, { status: 409 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'break_glass.approval_requested', targetId: id, reason, outcome: 'success' })
  const approved = await db.adminBreakGlassGrant.updateMany({ where: { id, approverId: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { approverId: actor.userId } })
  if (!approved.count) return NextResponse.json({ error: 'Grant changed' }, { status: 409 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'break_glass.approved', targetId: id, reason, after: { permission: grant.permission }, outcome: 'success' })
  return NextResponse.json({ id, permission: grant.permission, expiresAt: grant.expiresAt }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
