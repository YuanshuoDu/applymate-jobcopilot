import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { sendWorkerCommand } from '@/lib/admin/worker-client'
import { runAdminMutation } from '@/lib/admin/write-transaction'

const queues = ['apply-tasks', 'scout-tasks', 'agent-runs']

export async function POST(request: NextRequest, context: { params: Promise<{ queue: string }> }) {
  const actor = await requireAdmin('queues.retry', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { queue } = await context.params
  const payload = await request.json().catch(() => null) as { jobId?: unknown; reason?: unknown } | null
  const jobId = typeof payload?.jobId === 'string' ? payload.jobId.trim() : ''
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!queues.includes(queue) || !jobId || jobId.length > 200 || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid queue retry' }, { status: 400 })
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'queue.retry_requested',
    idempotencyKey: key,
    targetId: `${queue}:${jobId}`,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'queue', targetId: queue, reason, outcome: 'success', after: { jobId } },
    mutate: async () => ({ queue, jobId }),
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  try {
    const command = await sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: 'retry_queue_job', reason, params: { queue, jobId } })
    await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'queue.job_retried', targetType: 'queue', targetId: queue, reason, outcome: 'success', after: { jobId, receipt: command.receipt ?? null } })
    return NextResponse.json({ queue, jobId, receipt: command.receipt }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch {
    await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'queue.job_retry_failed', targetType: 'queue', targetId: queue, reason, outcome: 'failed', errorCode: 'worker_control_unavailable', after: { jobId } }).catch(() => undefined)
    return NextResponse.json({ error: 'Queue control plane unavailable' }, { status: 503 })
  }
}
