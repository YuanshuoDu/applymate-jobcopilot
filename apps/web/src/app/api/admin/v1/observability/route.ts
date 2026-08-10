import { NextRequest, NextResponse } from 'next/server'
import { getObservabilitySnapshot } from '@/lib/admin/observability'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('observability.read', request)
  if (isAdminResponse(actor)) return actor
  const snapshot = await getObservabilitySnapshot()
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'observability.viewed', outcome: 'success' })
  return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
