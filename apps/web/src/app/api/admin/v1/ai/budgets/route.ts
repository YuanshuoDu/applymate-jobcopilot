import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('ai_budget.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursor = params.get('cursor')
  const rows = await db.aiBudget.findMany({
    select: { id: true, userId: true, month: true, used: true, limit: true, updatedAt: true },
    orderBy: { id: 'asc' }, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: limit + 1,
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ai_budget.list_viewed', outcome: 'success' })
  return NextResponse.json(pageResult(rows.map((row) => ({ ...row, remaining: Math.max(row.limit - row.used, 0) })), limit), { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
