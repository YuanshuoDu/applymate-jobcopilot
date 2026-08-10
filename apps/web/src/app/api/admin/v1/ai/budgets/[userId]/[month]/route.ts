import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { parseBudgetLimit, updateBudgetLimitInTransaction } from '@/lib/admin/budget-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

function validMonth(value: string) { return /^20\d{2}-(0[1-9]|1[0-2])$/.test(value) }
type BudgetLimitResult = { used: number; limit: number; version: number }

export async function PATCH(request: NextRequest, context: { params: Promise<{ userId: string; month: string }> }) {
  const actor = await requireAdmin('ai_budget.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { userId, month } = await context.params
  const payload = await request.json().catch(() => null) as { limit?: unknown; version?: unknown; reason?: unknown; confirmBelowUsed?: unknown } | null
  const limit = parseBudgetLimit(payload?.limit)
  const version = typeof payload?.version === 'number' && Number.isInteger(payload.version) ? payload.version : -1
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!validMonth(month) || limit === null || version < 1 || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid budget override' }, { status: 400 })
  const current = await db.aiBudget.findUnique({ where: { userId_month: { userId, month } }, select: { used: true, version: true } })
  if (!current) return NextResponse.json({ error: 'Budget not found' }, { status: 404 })
  if (limit < current.used && payload?.confirmBelowUsed !== true) return NextResponse.json({ error: 'Reducing below used credits requires confirmation' }, { status: 400 })
  try {
    const result = await runAdminMutation<BudgetLimitResult>({
      actorUserId: actor.userId,
      action: 'ai_budget.limit_updated',
      idempotencyKey: key,
      targetId: `${userId}:${month}`,
      audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'ai_budget', targetId: `${userId}:${month}`, tenantUserId: userId, reason, after: { limit, version: version + 1 }, outcome: 'success' },
      mutate: async (tx) => {
        const updated = await updateBudgetLimitInTransaction(tx, { userId, month, limit, version, actorUserId: actor.userId, reason, idempotencyKey: key })
        if (!updated) throw new AdminMutationConflict('Budget changed or was not found')
        return updated
      },
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json({ ...result.value, remaining: Math.max(result.value.limit - result.value.used, 0) }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
