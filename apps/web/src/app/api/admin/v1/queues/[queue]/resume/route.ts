import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { sendWorkerCommand } from '@/lib/admin/worker-client'
import { runAdminMutation } from '@/lib/admin/write-transaction'

const queues = ['apply-tasks', 'scout-tasks', 'agent-runs']
type QueueCommandResult = { queue: string }

export async function POST(request: NextRequest, context: { params: Promise<{ queue: string }> }) {
  const actor = await requireAdmin('queues.resume', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { queue } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!queues.includes(queue) || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid queue resume' }, { status: 400 })
  try {
    const result = await runAdminMutation<QueueCommandResult>({
      actorUserId: actor.userId,
      action: 'queue.resume_requested',
      idempotencyKey: key,
      targetId: queue,
      audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'queue', targetId: queue, reason, outcome: 'success' },
      mutate: async () => ({ queue }),
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
    try {
      const command = await sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: 'resume_queue', reason, params: { queue } })
      await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'queue.resumed', targetType: 'queue', targetId: queue, reason, outcome: 'success', after: { receipt: command.receipt ?? null } })
      return NextResponse.json({ queue, receipt: command.receipt }, { headers: { 'Cache-Control': 'no-store' } })
    } catch {
      await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'queue.resume_failed', targetType: 'queue', targetId: queue, reason, outcome: 'failed', errorCode: 'worker_control_unavailable' }).catch(() => undefined)
      return NextResponse.json({ error: 'Queue control plane unavailable' }, { status: 503 })
    }
  } catch { return NextResponse.json({ error: 'Queue control plane unavailable' }, { status: 503 }) }
}
