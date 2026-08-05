import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
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
  const updated = await db.adminBroadcast.updateMany({ where: { id, status: { in: ['draft', 'pending_approval', 'scheduled'] } }, data: { status: 'cancelled' } })
  if (!updated.count) return NextResponse.json({ error: 'Broadcast cannot be cancelled' }, { status: 409 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'broadcast.cancelled', targetType: 'broadcast', targetId: id, reason, outcome: 'success' })
  return NextResponse.json({ broadcast: { id, status: 'cancelled' } }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
