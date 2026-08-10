import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'
import { runAdminMutation } from '@/lib/admin/write-transaction'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('broadcasts.schedule', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const body = await request.json().catch(() => null) as { scheduledAt?: unknown; reason?: unknown } | null
  const scheduledAt = typeof body?.scheduledAt === 'string' ? new Date(body.scheduledAt) : null
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now() || scheduledAt.getTime() > Date.now() + 90 * 24 * 60 * 60_000 || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Schedule must be a future time within 90 days' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast.scheduled', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', targetId: id, reason, outcome: 'success', after: { scheduledAt } }, mutate: (tx) => tx.adminBroadcast.updateMany({ where: { id, status: 'draft', approvedById: { not: null } }, data: { status: 'scheduled', scheduledAt } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  if (!result.value.count) return NextResponse.json({ error: 'Broadcast must be approved before scheduling' }, { status: 409 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'broadcast.schedule_committed', targetType: 'broadcast', targetId: id, reason, outcome: 'success', after: { scheduledAt } })
  return NextResponse.json({ id, status: 'scheduled', scheduledAt }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
