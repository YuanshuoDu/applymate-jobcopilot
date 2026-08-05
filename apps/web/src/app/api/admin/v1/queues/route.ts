import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { sendWorkerCommand } from '@/lib/admin/worker-client'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('queues.read', request)
  if (isAdminResponse(actor)) return actor
  try {
    const result = await sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: 'queue_summary', reason: 'View queue health summary', params: {} })
    await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'queues.summary_viewed', targetType: 'queue', outcome: 'success' })
    return NextResponse.json({ queues: result.queues ?? [] }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch {
    return NextResponse.json({ error: 'Queue control plane unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  }
}
