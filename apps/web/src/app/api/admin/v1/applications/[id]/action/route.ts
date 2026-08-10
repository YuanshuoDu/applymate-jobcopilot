import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { queueApplicationFill } from '@/lib/auto-apply'
import type { Permission } from '@/lib/admin/permissions'
import { db } from '@/lib/db'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const body = await request.json().catch(() => null) as { action?: unknown; reason?: unknown } | null
  const action = body?.action
  const permission: Permission | null = action === 'retry' ? 'applications.retry' : action === 'cancel' ? 'applications.cancel' : action === 'manual_review' ? 'applications.manual_review' : null
  if (!permission) return NextResponse.json({ error: 'action must be retry, cancel, or manual_review' }, { status: 400 })
  const actor = await requireAdmin(permission, request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const idempotencyKey = request.headers.get('idempotency-key')
  if (reason.length < 10 || reason.length > 500 || !idempotencyKey) return NextResponse.json({ error: 'A reason and Idempotency-Key are required' }, { status: 400 })
  const { id } = await params
  const task = await db.applicationTask.findUnique({ where: { id }, select: { id: true, userId: true, jobId: true, status: true, checkpoint: true, job: { select: { url: true } } } })
  if (!task) return NextResponse.json({ error: 'Application task not found' }, { status: 404 })

  if (action === 'retry') {
    if (!['failed', 'cancelled'].includes(task.status)) return NextResponse.json({ error: 'Only failed or cancelled tasks can be retried' }, { status: 409 })
    const prepared = await runAdminMutation({ actorUserId: actor.userId, action: 'application.retry_requested', idempotencyKey, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'application', targetId: id, tenantUserId: task.userId, reason, outcome: 'success', before: { status: task.status }, after: { status: 'waiting_for_user', checkpoint: 'materials_ready' } }, mutate: tx => Promise.all([tx.applicationTask.update({ where: { id }, data: { status: 'waiting_for_user', checkpoint: 'materials_ready', error: null, completedAt: null } }), tx.applicationTaskEvent.create({ data: { taskId: id, type: 'admin_retry_requested', actor: 'system', body: reason } })]) })
    if (prepared.duplicate) return NextResponse.json({ duplicate: true })
    try {
      const queued = await queueApplicationFill({ userId: task.userId, jobId: task.jobId, applyUrl: task.job.url, applicationTaskId: id })
      return NextResponse.json({ action, ...queued }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to queue application retry'
      await db.applicationTask.updateMany({ where: { id, status: 'filling' }, data: { status: 'failed', checkpoint: 'admin_retry_failed', error: message, completedAt: new Date() } }).catch(() => undefined)
      await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'application.retry_failed', targetType: 'application', targetId: id, tenantUserId: task.userId, reason, outcome: 'failed', errorCode: 'queue_unavailable' }).catch(() => undefined)
      return NextResponse.json({ error: 'Application retry could not be queued' }, { status: 503 })
    }
  }

  if (action === 'cancel' && ['submitted', 'skipped', 'cancelled'].includes(task.status)) return NextResponse.json({ error: 'This application task cannot be cancelled' }, { status: 409 })
  if (action === 'manual_review' && ['submitted', 'cancelled'].includes(task.status)) return NextResponse.json({ error: 'This application task cannot be moved to review' }, { status: 409 })
  const next = action === 'cancel' ? { status: 'cancelled', checkpoint: 'cancelled_by_admin', completedAt: new Date() } : { status: 'waiting_for_user', checkpoint: 'admin_review', completedAt: null }
  const result = await runAdminMutation({ actorUserId: actor.userId, action: action === 'cancel' ? 'application.cancelled_by_admin' : 'application.review_requested', idempotencyKey, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'application', targetId: id, tenantUserId: task.userId, reason, outcome: 'success', before: { status: task.status, checkpoint: task.checkpoint }, after: next }, mutate: tx => Promise.all([tx.applicationTask.update({ where: { id }, data: { ...next, error: action === 'cancel' ? reason : 'Manual review requested by an administrator' } }), tx.applicationTaskEvent.create({ data: { taskId: id, type: action === 'cancel' ? 'cancelled_by_admin' : 'manual_review_requested', actor: 'system', body: reason } })]) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ action, status: next.status }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
