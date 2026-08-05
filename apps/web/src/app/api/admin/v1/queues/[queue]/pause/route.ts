import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { sendWorkerCommand } from '@/lib/admin/worker-client'
import { runAdminMutation } from '@/lib/admin/write-transaction'

const queues = ['apply-tasks', 'scout-tasks', 'agent-runs']
type QueueCommandResult = { receipt?: string; queues?: unknown; error?: string }

export async function POST(request: NextRequest, context: { params: Promise<{ queue: string }> }) {
  const actor = await requireAdmin('queues.pause', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { queue } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!queues.includes(queue) || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid queue pause' }, { status: 400 })
  try {
    const result = await runAdminMutation<QueueCommandResult>({
      actorUserId: actor.userId,
      action: 'queue.paused',
      idempotencyKey: key,
      targetId: queue,
      audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'queue', targetId: queue, reason, outcome: 'success' },
      mutate: () => sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: 'pause_queue', reason, params: { queue } }),
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json({ queue, receipt: result.value.receipt }, { headers: { 'Cache-Control': 'no-store' } })
  } catch { return NextResponse.json({ error: 'Queue control plane unavailable' }, { status: 503 }) }
}
