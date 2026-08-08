import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { POLICIES } from '@/lib/agent/pace/policies'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('ats.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursorValue = params.get('cursor')
  const cursor = cursorValue && /^\d+$/.test(cursorValue) ? Number(cursorValue) : undefined
  const rows = await db.atsEmployer.findMany({
    select: { id: true, atsType: true, slug: true, name: true, firstSeen: true, lastSeen: true, jobCount: true },
    orderBy: { id: 'asc' }, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: limit + 1,
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ats.registry_viewed', outcome: 'success' })
  const page = pageResult(rows.map((row) => ({ ...row, rateLimitRps: POLICIES[row.atsType]?.rps ?? null, credentialRequirement: 'none' })), limit)
  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
