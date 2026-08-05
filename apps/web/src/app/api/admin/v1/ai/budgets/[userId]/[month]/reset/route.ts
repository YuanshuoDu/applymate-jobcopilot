import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'

function validMonth(value: string) { return /^20\d{2}-(0[1-9]|1[0-2])$/.test(value) }

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
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ai_budget.reset_requested', targetType: 'ai_budget', targetId: `${userId}:${month}`, tenantUserId: userId, reason, outcome: 'success' })
  const resetRequest = await db.aiBudgetResetRequest.create({ data: { budgetId: budget.id, requesterId: actor.userId, reason, budgetVersion: budget.version, createIdempotencyKey: key, expiresAt: new Date(Date.now() + 30 * 60_000) }, select: { id: true, status: true, expiresAt: true } })
  return NextResponse.json({ request: resetRequest }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
