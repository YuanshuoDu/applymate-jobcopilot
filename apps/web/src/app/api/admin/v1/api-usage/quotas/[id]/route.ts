import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdminAny } from '@/lib/admin/authorization'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

const validPeriods = new Set(['week', 'month'])

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdminAny(['ats.update', 'ai_budget.update'], request)
  if (isAdminResponse(actor)) return actor
  const { id } = await context.params
  const existing = await db.apiQuota.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Quota not found' }, { status: 404 })
  const required = existing.category === 'ai' ? 'ai_budget.update' : 'ats.update'
  if (!actor.permissions.includes(required)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const planName = typeof body?.planName === 'string' ? body.planName.trim().slice(0, 80) : ''
  const period = typeof body?.period === 'string' ? body.period : ''
  const limit = typeof body?.limit === 'number' && Number.isFinite(body.limit) ? body.limit : -1
  const resetDay = typeof body?.resetDay === 'number' ? Math.trunc(body.resetDay) : -1
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
  const version = typeof body?.version === 'number' ? Math.trunc(body.version) : -1
  const maxReset = period === 'week' ? 6 : 28
  if (!planName || !validPeriods.has(period) || limit < 0 || resetDay < (period === 'week' ? 0 : 1) || resetDay > maxReset || reason.length < 10 || version < 1) {
    return NextResponse.json({ error: 'Invalid quota update' }, { status: 400 })
  }
  const idempotencyKey = request.headers.get('idempotency-key') ?? ''
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'api_quota.updated',
    idempotencyKey,
    targetId: id,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetId: id, reason, outcome: 'success', before: existing, after: { planName, period, limit, resetDay } },
    mutate: async tx => {
      const updated = await tx.apiQuota.updateMany({ where: { id, version }, data: { planName, period, limit, resetDay, updatedById: actor.userId, version: { increment: 1 } } })
      if (updated.count !== 1) throw new Error('Quota version conflict')
      return tx.apiQuota.findUniqueOrThrow({ where: { id } })
    },
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  return NextResponse.json({ quota: result.value, duplicate: false }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
