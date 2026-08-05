import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { claimAdminIdempotencyKey } from '@/lib/admin/idempotency'
import { sendWorkerCommand } from '@/lib/admin/worker-client'

const queues = ['apply-tasks', 'scout-tasks', 'agent-runs']

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
  if (!await claimAdminIdempotencyKey(actor.userId, 'queues.pause', key, queue)) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'queue.pause_requested', targetType: 'queue', targetId: queue, reason, outcome: 'success' })
  try {
    const result = await sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: 'pause_queue', reason, params: { queue } })
    await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'queue.paused', targetType: 'queue', targetId: queue, reason, outcome: 'success' })
    return NextResponse.json({ queue, receipt: result.receipt }, { headers: { 'Cache-Control': 'no-store' } })
  } catch { return NextResponse.json({ error: 'Queue control plane unavailable' }, { status: 503 }) }
}
