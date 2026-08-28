import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { applicationTaskCounts, toAdminApplicationTaskSummary } from '@/lib/admin/application-dto'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { APPLICATION_TASK_STATUSES } from '@/lib/agent/application-control'
import { db } from '@/lib/db'

const OUTCOMES = ['submitted', 'manual', 'failed', 'dry-run'] as const
const MODES = ['unattended', 'assisted'] as const

function selected(value: string | null, allowed: readonly string[]) {
  const normalized = value?.trim() ?? ''
  return allowed.includes(normalized) ? normalized : ''
}

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('applications.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursor = params.get('cursor')?.trim().slice(0, 64) || undefined
  const query = params.get('q')?.trim().slice(0, 120) ?? ''
  const status = selected(params.get('status'), APPLICATION_TASK_STATUSES)
  const outcome = selected(params.get('outcome'), OUTCOMES)
  const mode = selected(params.get('mode'), MODES)
  const atsType = params.get('atsType')?.trim().slice(0, 40) ?? ''
  const resultWhere: Prisma.ApplyResultWhereInput = {
    ...(outcome ? { status: outcome } : {}),
    ...(mode ? { mode } : {}),
    ...(atsType ? { atsType } : {}),
  }
  const latestResultTaskIds = outcome || mode || atsType
    ? (await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT task.id
        FROM application_tasks task
        JOIN LATERAL (
          SELECT result.status, result.mode, result.ats_type
          FROM apply_results result
          WHERE result.job_id = task.job_id AND result.user_id = task.user_id
          ORDER BY result.created_at DESC, result.id DESC
          LIMIT 1
        ) latest ON TRUE
        WHERE (${outcome || null}::text IS NULL OR latest.status = ${outcome || null})
          AND (${mode || null}::text IS NULL OR latest.mode = ${mode || null})
          AND (${atsType || null}::text IS NULL OR latest.ats_type = ${atsType || null})
      `)).map(row => row.id)
    : undefined
  const filters: Prisma.ApplicationTaskWhereInput[] = []
  if (query) {
    filters.push({ OR: [
      { id: { contains: query, mode: 'insensitive' } },
      { userId: { contains: query, mode: 'insensitive' } },
      { jobId: { contains: query, mode: 'insensitive' } },
      { job: { is: { OR: [{ company: { contains: query, mode: 'insensitive' } }, { role: { contains: query, mode: 'insensitive' } }] } } },
    ] })
  }
  if (outcome || mode || atsType) filters.push({ job: { is: { applyResults: { some: resultWhere } } } })
  const baseWhere: Prisma.ApplicationTaskWhereInput = filters.length ? { AND: filters } : {}
  const where: Prisma.ApplicationTaskWhereInput = { ...baseWhere, ...(status ? { status } : {}), ...(latestResultTaskIds ? { id: { in: latestResultTaskIds } } : {}) }
  const direction: Prisma.SortOrder = params.get('direction') === 'asc' ? 'asc' : 'desc'
  const sort = params.get('sort')
  const primaryOrder: Prisma.ApplicationTaskOrderByWithRelationInput = sort === 'status'
    ? { status: direction }
    : sort === 'createdAt' ? { createdAt: direction } : { updatedAt: direction }

  const [rows, grouped] = await Promise.all([
    db.applicationTask.findMany({
      where,
      select: {
        id: true, userId: true, jobId: true, status: true, checkpoint: true, error: true,
        startedAt: true, completedAt: true, createdAt: true, updatedAt: true,
        job: { select: { company: true, role: true, source: true, applyResults: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, userId: true, jobId: true, status: true, mode: true, atsType: true, flowUsed: true, error: true, durationMs: true, createdAt: true } } } },
      },
      orderBy: [primaryOrder, { id: direction }], cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : undefined, take: limit + 1,
    }),
    db.applicationTask.groupBy({ by: ['status'], where, _count: { _all: true } }),
  ])
  const items = rows.map(row => toAdminApplicationTaskSummary(row, row.job.applyResults[0] ?? null))
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'applications.list_viewed', outcome: 'success' })
  return NextResponse.json({ ...pageResult(items, limit), summary: applicationTaskCounts(grouped) }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
