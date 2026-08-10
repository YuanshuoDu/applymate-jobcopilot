import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { sendWorkerCommand } from '@/lib/admin/worker-client'

const queues = ['apply-tasks', 'scout-tasks', 'agent-runs']
const deadLetterQueue = 'dead-letter'

export async function GET(request: NextRequest, context: { params: Promise<{ queue: string }> }) {
  const actor = await requireAdmin('queues.read', request)
  if (isAdminResponse(actor)) return actor
  const { queue } = await context.params
  if (!queues.includes(queue) && queue !== deadLetterQueue) return NextResponse.json({ error: 'Unsupported queue' }, { status: 400 })
  try {
    const result = await sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: queue === deadLetterQueue ? 'dead_letter_jobs' : 'failed_queue_jobs', reason: 'View failed queue jobs for operational triage', params: { queue } })
    await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'queue.failed_viewed', targetType: 'queue', targetId: queue, outcome: 'success' })
    return NextResponse.json({ queue, jobs: result.jobs ?? [] }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch {
    return NextResponse.json({ error: 'Queue control plane unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  }
}
