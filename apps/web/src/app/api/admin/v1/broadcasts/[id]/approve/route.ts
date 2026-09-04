import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('broadcasts.approve', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  if (reason.length < 10 || reason.length > 500 || !request.headers.get('idempotency-key')) return NextResponse.json({ error: 'Invalid approval request' }, { status: 400 })
  const broadcast = await db.adminBroadcast.findUnique({ where: { id }, select: { createdById: true, approvedById: true, status: true } })
  if (!broadcast) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (broadcast.createdById === actor.userId) return NextResponse.json({ error: 'Creator cannot approve this broadcast' }, { status: 403 })
  if (broadcast.approvedById || broadcast.status !== 'pending_approval') return NextResponse.json({ error: 'Broadcast is not awaiting approval' }, { status: 409 })
  const key = request.headers.get('idempotency-key') as string
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast.approved', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', targetId: id, reason, outcome: 'success' }, mutate: (tx) => tx.adminBroadcast.update({ where: { id }, data: { approvedById: actor.userId, status: 'draft' }, select: { id: true, approvedById: true, status: true } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const updated = result.value
  return NextResponse.json({ broadcast: updated }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
