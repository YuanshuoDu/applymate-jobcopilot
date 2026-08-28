import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { toAdminApplicationTaskMetadata, toAdminApplicationTaskSummary } from '@/lib/admin/application-dto'
import { db } from '@/lib/db'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const actor = await requireAdmin('applications.read', request)
  if (isAdminResponse(actor)) return actor
  const id = (await params).id.trim()
  if (!id || id.length > 64) return NextResponse.json({ error: 'Invalid application task id' }, { status: 400 })
  const task = await db.applicationTask.findUnique({
    where: { id },
    select: {
      id: true, userId: true, jobId: true, status: true, checkpoint: true, error: true,
      startedAt: true, completedAt: true, createdAt: true, updatedAt: true,
      job: { select: { company: true, role: true, source: true, applyResults: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, userId: true, jobId: true, status: true, mode: true, atsType: true, flowUsed: true, error: true, durationMs: true, createdAt: true } } } },
      events: { orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, type: true, actor: true, body: true, createdAt: true } },
    },
  })
  if (!task) return NextResponse.json({ error: 'Application task not found' }, { status: 404 })
  const application = toAdminApplicationTaskSummary(task, task.job.applyResults[0] ?? null)
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'application.detail_viewed', targetType: 'application', targetId: id, tenantUserId: task.userId, outcome: 'success' })
  return NextResponse.json({ application, task: toAdminApplicationTaskMetadata(task) }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
