import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { adminUserMetadataSelect, toAdminUserMetadata } from '@/lib/admin/dto'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('admin_members.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursor = params.get('cursor')
  const rows = await db.adminMembership.findMany({
    select: { id: true, status: true, mfaLevel: true, sessionVersion: true, grantedAt: true, revokedAt: true, user: { select: adminUserMetadataSelect }, role: { select: { key: true, name: true } } },
    orderBy: { id: 'asc' }, cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : undefined, take: limit + 1,
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin_members.list_viewed', outcome: 'success' })
  return NextResponse.json(pageResult(rows.map((row) => ({ ...row, user: toAdminUserMetadata(row.user) })), limit), { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
