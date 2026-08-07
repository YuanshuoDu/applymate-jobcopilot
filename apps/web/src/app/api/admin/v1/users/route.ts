import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { adminUserMetadataSelect, toAdminUserMetadata } from '@/lib/admin/dto'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('users.read', request)
  if (isAdminResponse(actor)) return actor
  const params = new URL(request.url).searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursor = params.get('cursor')
  const search = params.get('q')?.trim().slice(0, 100)
  const rows = await db.user.findMany({
    where: search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } : undefined,
    select: adminUserMetadataSelect,
    orderBy: { id: 'asc' },
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : undefined,
    take: limit + 1,
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'users.list_viewed', outcome: 'success' })
  const page = pageResult(rows.map(toAdminUserMetadata), limit)
  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
