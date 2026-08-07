import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

function validMonth(value: string) { return /^20\d{2}-(0[1-9]|1[0-2])$/.test(value) }
type ResetRequestResult = { id: string; status: string; expiresAt: Date }

export async function POST(request: NextRequest, context: { params: Promise<{ userId: string; month: string }> }) {
  const actor = await requireAdmin('ai_budget.reset', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { userId, month } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!validMonth(month) || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid reset request' }, { status: 400 })
  const existing = await db.aiBudgetResetRequest.findUnique({ where: { createIdempotencyKey: key }, select: { id: true, status: true } })
  if (existing) return NextResponse.json({ request: existing, duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const budget = await db.aiBudget.findUnique({ where: { userId_month: { userId, month } }, select: { id: true, version: true } })
  if (!budget) return NextResponse.json({ error: 'Budget not found' }, { status: 404 })
  try {
    const result = await runAdminMutation<ResetRequestResult>({
      actorUserId: actor.userId,
      action: 'ai_budget.reset_requested',
      idempotencyKey: key,
      targetId: `${userId}:${month}`,
      audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'ai_budget', targetId: `${userId}:${month}`, tenantUserId: userId, reason, outcome: 'success' },
      mutate: async (tx) => {
        const current = await tx.aiBudget.findUnique({ where: { id: budget.id }, select: { version: true } })
        if (!current) throw new AdminMutationConflict('Budget changed or was not found')
        return tx.aiBudgetResetRequest.create({ data: { budgetId: budget.id, requesterId: actor.userId, reason, budgetVersion: current.version, createIdempotencyKey: key, expiresAt: new Date(Date.now() + 30 * 60_000) }, select: { id: true, status: true, expiresAt: true } })
      },
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json({ request: result.value }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
