import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { sendWorkerCommand } from '@/lib/admin/worker-client'
import { runAdminMutation } from '@/lib/admin/write-transaction'

const workerActions = { pause: { permission: 'queues.pause', command: 'pause_worker', audit: 'worker.paused' }, resume: { permission: 'queues.resume', command: 'resume_worker', audit: 'worker.resumed' } } as const

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('queues.read', request)
  if (isAdminResponse(actor)) return actor
  try {
    const result = await sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: 'queue_summary', reason: 'View queue health summary', params: {} })
    await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'queues.summary_viewed', targetType: 'queue', outcome: 'success' })
    return NextResponse.json({ queues: result.queues ?? [], worker: result.worker ?? null }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch {
    return NextResponse.json({ error: 'Queue control plane unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  }
}

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null) as { action?: unknown; reason?: unknown } | null
  const actionKey = typeof payload?.action === 'string' ? payload.action as keyof typeof workerActions : undefined
  const action = actionKey ? workerActions[actionKey] : undefined
  if (!action) return NextResponse.json({ error: 'Invalid worker action' }, { status: 400 })
  const actor = await requireAdmin(action.permission, request)
  if (isAdminResponse(actor)) return actor
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid worker action' }, { status: 400 })

  try {
    const mutation = await runAdminMutation({
      actorUserId: actor.userId,
      action: `worker.${action.command}_requested`,
      idempotencyKey: key,
      targetId: 'worker',
      audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'queue', targetId: 'worker', reason, outcome: 'success' },
      mutate: async () => ({ action: actionKey }),
    })
    if (mutation.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })

    try {
      const command = await sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: action.command, reason, params: {} })
      await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: action.audit, targetType: 'queue', targetId: 'worker', reason, outcome: 'success', after: { receipt: command.receipt ?? null, state: command.worker?.state ?? null } })
      return NextResponse.json({ receipt: command.receipt, worker: command.worker ?? null }, { headers: { 'Cache-Control': 'no-store' } })
    } catch {
      await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: `${action.audit}_failed`, targetType: 'queue', targetId: 'worker', reason, outcome: 'failed', errorCode: 'worker_control_unavailable' }).catch(() => undefined)
      return NextResponse.json({ error: 'Worker control plane unavailable' }, { status: 503 })
    }
  } catch {
    return NextResponse.json({ error: 'Worker control plane unavailable' }, { status: 503 })
  }
}
