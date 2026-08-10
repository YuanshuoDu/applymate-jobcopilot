import { NextRequest, NextResponse } from 'next/server'
import { getObservabilitySnapshot } from '@/lib/admin/observability'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { getQueueSloSnapshot } from '@/lib/admin/queue-slo'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('observability.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const daysValue = Number(params.get('days'))
  const days = Number.isInteger(daysValue) && daysValue >= 1 && daysValue <= 3_650 ? daysValue : undefined
  const atsType = params.get('atsType')?.trim().slice(0, 40) || undefined
  const [snapshot, queue] = await Promise.all([getObservabilitySnapshot({ days, atsType }), getQueueSloSnapshot()])
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'observability.viewed', outcome: 'success' })
  return NextResponse.json({ ...snapshot, queue }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
