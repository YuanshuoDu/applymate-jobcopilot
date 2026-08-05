import { NextRequest, NextResponse } from 'next/server'
import { AdminMembershipStatus } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { claimAdminIdempotencyKey } from '@/lib/admin/idempotency'
import { parseSupportCaseUpdate } from '@/lib/admin/support-case'
import { db } from '@/lib/db'

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('support_cases.assign', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const input = parseSupportCaseUpdate(payload)
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!input || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid support case update' }, { status: 400 })
  if (input.status === 'resolved' && !actor.permissions.includes('support_cases.resolve')) return NextResponse.json({ error: 'Resolution permission required' }, { status: 403 })
  if (!await claimAdminIdempotencyKey(actor.userId, 'support.case_updated', key, id)) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const supportCase = await db.supportCase.findUnique({ where: { id }, select: { requesterUserId: true } })
  if (!supportCase) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (input.assignedAdminId) {
    const assignee = await db.adminMembership.findUnique({ where: { userId: input.assignedAdminId }, select: { status: true, role: { select: { key: true } } } })
    if (assignee?.status !== AdminMembershipStatus.active || assignee.role.key !== 'support') return NextResponse.json({ error: 'Assignee must be an active support member' }, { status: 400 })
  }
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'support.case_update_requested', targetType: 'support_case', targetId: id, tenantUserId: supportCase.requesterUserId, reason, outcome: 'success' })
  const update = await db.supportCase.updateMany({ where: { id, version: input.version }, data: { ...(input.status ? { status: input.status } : {}), ...(input.priority ? { priority: input.priority } : {}), ...(input.assignedAdminId !== undefined ? { assignedAdminId: input.assignedAdminId } : {}), ...(input.status === 'resolved' ? { resolvedAt: new Date() } : {}), version: { increment: 1 } } })
  if (!update.count) return NextResponse.json({ error: 'Case changed' }, { status: 409 })
  const action = input.status === 'resolved' ? 'support.case_resolved' : input.assignedAdminId !== undefined ? 'support.case_assigned' : 'support.case_updated'
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action, targetType: 'support_case', targetId: id, tenantUserId: supportCase.requesterUserId, reason, after: { version: input.version + 1 }, outcome: 'success' })
  return NextResponse.json({ id, version: input.version + 1 }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
