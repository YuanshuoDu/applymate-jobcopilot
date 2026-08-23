import { NextRequest, NextResponse } from 'next/server'
import { AdminMembershipStatus } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { parseSupportCaseUpdate, supportCaseScope } from '@/lib/admin/support-case'
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
  const scope = supportCaseScope(actor)
  const supportCase = await db.supportCase.findFirst({ where: { id, ...scope }, select: { requesterUserId: true } })
  if (!supportCase) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const tenantUserId = supportCase.requesterUserId ?? undefined
  if (input.assignedAdminId) {
    const assignee = await db.adminMembership.findUnique({ where: { userId: input.assignedAdminId }, select: { status: true, role: { select: { key: true } } } })
    if (assignee?.status !== AdminMembershipStatus.active || assignee.role.key !== 'support') return NextResponse.json({ error: 'Assignee must be an active support member' }, { status: 400 })
  }
  const action = input.status === 'resolved' ? 'support.case_resolved' : input.assignedAdminId !== undefined ? 'support.case_assigned' : 'support.case_updated'
  try {
    const result = await runAdminMutation({
      actorUserId: actor.userId,
      action,
      idempotencyKey: key,
      targetId: id,
      audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'support_case', targetId: id, tenantUserId, reason, after: { version: input.version + 1 }, outcome: 'success' },
      mutate: async (tx) => {
        const update = await tx.supportCase.updateMany({
          where: { id, version: input.version, ...scope },
          data: { ...(input.status ? { status: input.status } : {}), ...(input.priority ? { priority: input.priority } : {}), ...(input.assignedAdminId !== undefined ? { assignedAdminId: input.assignedAdminId } : {}), ...(input.status === 'resolved' ? { resolvedAt: new Date() } : {}), version: { increment: 1 } },
        })
        if (!update.count) throw new AdminMutationConflict('Case changed or access is no longer available')
        return update
      },
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json({ id, version: input.version + 1 }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
