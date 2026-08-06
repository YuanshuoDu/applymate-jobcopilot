import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('audit.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursor = params.get('cursor')
  const rows = await db.adminAuditLog.findMany({
    select: { id: true, actorRoleKey: true, action: true, targetType: true, targetId: true, outcome: true, errorCode: true, createdAt: true },
    orderBy: { id: 'desc' }, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: limit + 1,
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'audit.list_viewed', outcome: 'success' })
  return NextResponse.json(pageResult(rows, limit), { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
