import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { approveBudgetResetInTransaction } from '@/lib/admin/budget-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

type BudgetResetResult = { budgetId: string; version: number; previousUsed: number }

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
  try {
    const result = await runAdminMutation<BudgetResetResult>({
      actorUserId: actor.userId,
      action: 'ai_budget.reset_approved',
      idempotencyKey: key,
      targetId: id,
      audit: (value) => ({ requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'ai_budget', targetId: `${resetRequest.budget.userId}:${resetRequest.budget.month}`, tenantUserId: resetRequest.budget.userId, reason, after: { previousUsed: value.previousUsed, version: value.version }, outcome: 'success' }),
      mutate: async (tx) => {
        const approved = await approveBudgetResetInTransaction(tx, { requestId: id, approverId: actor.userId, idempotencyKey: key })
        if (!approved) throw new AdminMutationConflict('Reset expired, changed, or already approved')
        return approved
      },
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json({ reset: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
