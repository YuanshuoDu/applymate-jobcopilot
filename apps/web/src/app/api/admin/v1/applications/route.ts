import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { toAdminApplicationMetadata } from '@/lib/admin/application-dto'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('applications.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursorValue = params.get('cursor')
  const cursor = cursorValue && /^\d+$/.test(cursorValue) ? Number(cursorValue) : undefined
  const rows = await db.applyResult.findMany({
    select: { id: true, userId: true, jobId: true, status: true, mode: true, atsType: true, flowUsed: true, error: true, durationMs: true, createdAt: true },
    orderBy: { id: 'desc' }, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: limit + 1,
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'applications.list_viewed', outcome: 'success' })
  return NextResponse.json(pageResult(rows.map(toAdminApplicationMetadata), limit), { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
