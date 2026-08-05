import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { audienceWhere, storedAudience } from '@/lib/admin/broadcast-service'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'broadcast.previewed', targetType: 'broadcast', targetId: id, outcome: 'success' })
  return NextResponse.json({ recipientCount, byPlan: byPlan.filter((row) => row._count._all >= 20).map((row) => ({ plan: row.plan, count: row._count._all })) }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
