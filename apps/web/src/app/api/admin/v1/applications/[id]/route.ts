import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { toAdminApplicationMetadata } from '@/lib/admin/application-dto'
import { db } from '@/lib/db'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const actor = await requireAdmin('applications.read', request)
  if (isAdminResponse(actor)) return actor
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: 'Invalid application id' }, { status: 400 })
  const result = await db.applyResult.findUnique({ where: { id }, select: { id: true, userId: true, jobId: true, status: true, mode: true, atsType: true, flowUsed: true, error: true, durationMs: true, createdAt: true } })
  if (!result) return NextResponse.json({ error: 'Application result not found' }, { status: 404 })
  const task = await db.applicationTask.findUnique({ where: { userId_jobId: { userId: result.userId, jobId: result.jobId } }, select: { id: true, status: true, checkpoint: true, error: true, startedAt: true, completedAt: true, createdAt: true, updatedAt: true, events: { orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, type: true, actor: true, body: true, createdAt: true } } } })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'application.detail_viewed', targetType: 'application', targetId: String(id), tenantUserId: result.userId, outcome: 'success' })
  return NextResponse.json({ application: toAdminApplicationMetadata({ ...result, taskId: task?.id ?? null, taskStatus: task?.status ?? null, checkpoint: task?.checkpoint ?? null }), task: task ? { ...task, events: task.events.map(event => ({ ...event, body: event.body.slice(0, 500) })) } : null }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
