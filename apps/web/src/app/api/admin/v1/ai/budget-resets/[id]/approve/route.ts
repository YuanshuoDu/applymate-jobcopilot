import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { approveBudgetReset } from '@/lib/admin/budget-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('ai_budget.reset', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid reset approval' }, { status: 400 })
  const duplicate = await db.aiBudgetResetRequest.findUnique({ where: { approveIdempotencyKey: key }, select: { id: true, status: true } })
  if (duplicate) return NextResponse.json({ request: duplicate, duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const resetRequest = await db.aiBudgetResetRequest.findUnique({ where: { id }, select: { requesterId: true, budget: { select: { userId: true, month: true } } } })
  if (!resetRequest) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (resetRequest.requesterId === actor.userId) return NextResponse.json({ error: 'Requester cannot approve this reset' }, { status: 403 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ai_budget.reset_approval_requested', targetType: 'ai_budget', targetId: `${resetRequest.budget.userId}:${resetRequest.budget.month}`, tenantUserId: resetRequest.budget.userId, reason, outcome: 'success' })
  const result = await approveBudgetReset({ requestId: id, approverId: actor.userId, idempotencyKey: key })
  if (!result) return NextResponse.json({ error: 'Reset expired, changed, or already approved' }, { status: 409 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ai_budget.reset_approved', targetType: 'ai_budget', targetId: `${resetRequest.budget.userId}:${resetRequest.budget.month}`, tenantUserId: resetRequest.budget.userId, reason, after: { previousUsed: result.previousUsed, version: result.version }, outcome: 'success' })
  return NextResponse.json({ reset: result }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
