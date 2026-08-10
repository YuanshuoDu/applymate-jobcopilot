import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { audienceWhere, storedAudience } from '@/lib/admin/broadcast-service'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const actor = await requireAdmin('broadcasts.preview', request)
  if (isAdminResponse(actor)) return actor
  const { id } = await context.params
  const broadcast = await db.adminBroadcast.findUnique({ where: { id }, select: { audienceType: true, audience: true } })
  const audience = broadcast && storedAudience(broadcast.audience, broadcast.audienceType)
  if (!audience) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const where = audienceWhere(audience)
  const [recipientCount, byPlan] = await Promise.all([
    db.user.count({ where }),
    db.user.groupBy({ by: ['plan'], where, _count: { _all: true } }),
  ])
  const key = request.headers.get('idempotency-key')
  if (!key) return NextResponse.json({ error: 'Idempotency-Key is required' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'broadcast.previewed', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'broadcast', targetId: id, outcome: 'success' }, mutate: async () => ({ recipientCount, byPlan: byPlan.filter((row) => row._count._all >= 20).map((row) => ({ plan: row.plan, count: row._count._all })) }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json(result.value, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
