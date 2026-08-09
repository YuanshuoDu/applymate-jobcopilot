import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('broadcasts.publish', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const body = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'A reason and Idempotency-Key are required' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast.retry_requested', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', targetId: id, reason, outcome: 'success' }, mutate: (tx) => tx.adminBroadcast.updateMany({ where: { id, status: 'failed' }, data: { status: 'draft', scheduledAt: null, approvedById: null, publishedById: null } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  if (!result.value.count) return NextResponse.json({ error: 'Only failed broadcasts can be retried' }, { status: 409 })
  return NextResponse.json({ id, status: 'draft' }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
