import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('broadcasts.cancel', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  if (reason.length < 10 || reason.length > 500 || !request.headers.get('idempotency-key')) return NextResponse.json({ error: 'Invalid cancellation request' }, { status: 400 })
  const key = request.headers.get('idempotency-key') as string
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast.cancelled', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', targetId: id, reason, outcome: 'success' }, mutate: (tx) => tx.adminBroadcast.updateMany({ where: { id, status: { in: ['draft', 'pending_approval', 'scheduled'] } }, data: { status: 'cancelled' } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const updated = result.value
  if (!updated.count) return NextResponse.json({ error: 'Broadcast cannot be cancelled' }, { status: 409 })
  return NextResponse.json({ broadcast: { id, status: 'cancelled' } }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
