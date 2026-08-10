import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { toAdminApplicationMetadata } from '@/lib/admin/application-dto'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('applications.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursorValue = params.get('cursor')
  const cursor = cursorValue && /^\d+$/.test(cursorValue) ? Number(cursorValue) : undefined
  const status = params.get('status')?.trim().slice(0, 40)
  const mode = params.get('mode')?.trim().slice(0, 40)
  const atsType = params.get('atsType')?.trim().slice(0, 40)
  const sort = params.get('sort')
  const direction = params.get('direction') === 'desc' ? 'desc' : 'asc'
  const orderBy: Prisma.ApplyResultOrderByWithRelationInput = sort === 'createdAt' ? { createdAt: direction } : sort === 'status' ? { status: direction } : sort === 'durationMs' ? { durationMs: direction } : { id: 'desc' }
  const rows = await db.applyResult.findMany({
    where: { ...(status ? { status } : {}), ...(mode ? { mode } : {}), ...(atsType ? { atsType } : {}) },
    select: { id: true, userId: true, jobId: true, status: true, mode: true, atsType: true, flowUsed: true, error: true, durationMs: true, createdAt: true },
    orderBy, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: limit + 1,
  })
  const taskRows = rows.length ? await Promise.resolve().then(() => db.applicationTask.findMany({
    where: { OR: rows.map(row => ({ userId: row.userId, jobId: row.jobId })) },
    select: { id: true, userId: true, jobId: true, status: true, checkpoint: true },
  })).catch(() => []) : []
  const tasks = new Map(taskRows.map(task => [`${task.userId}:${task.jobId}`, task]))
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'applications.list_viewed', outcome: 'success' })
  return NextResponse.json(pageResult(rows.map(row => toAdminApplicationMetadata({ ...row, ...(() => { const task = tasks.get(`${row.userId}:${row.jobId}`); return { taskId: task?.id ?? null, taskStatus: task?.status ?? null, checkpoint: task?.checkpoint ?? null } })() })), limit), { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
