import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'
import { runAdminMutation } from '@/lib/admin/write-transaction'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('broadcasts.preview', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const body = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim()
  if (reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'A reason and Idempotency-Key are required' }, { status: 400 })
  const broadcast = await db.adminBroadcast.findUnique({ where: { id }, select: { id: true, title: true, body: true } })
  if (!broadcast) return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast.test_sent', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', targetId: id, reason, outcome: 'success', after: { testUserId: actor.userId } }, mutate: tx => tx.notification.create({ data: { userId: actor.userId, type: 'platform_broadcast_test', title: `[Test] ${broadcast.title}`, body: broadcast.body } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ sent: true, notificationId: result.value.id }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
