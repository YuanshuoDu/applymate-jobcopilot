import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { db } from '@/lib/db'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { toAdminUserMetadata } from '@/lib/admin/dto'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('users.deletion.manage', request)
  if (isAdminResponse(actor)) return actor
  const params = request.nextUrl.searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursor = params.get('cursor')
  const status = params.get('status')?.trim()
  const requests = await db.adminDataDeletionRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: { requestedAt: 'desc' },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit + 1,
    include: { user: { select: { id: true, name: true, email: true, plan: true, accountStatus: true, location: true, createdAt: true, _count: { select: { jobs: true, resumes: true, notifications: true } }, gmailSyncState: { select: { lastSyncedAt: true, lastError: true } } } } },
  })
  const result = pageResult(requests, limit)
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'users.deletion_queue_viewed', outcome: 'success' })
  return NextResponse.json({ items: result.items.map((item) => ({ id: item.id, status: item.status, reason: item.reason, requestedAt: item.requestedAt, processedAt: item.processedAt, version: item.version, user: toAdminUserMetadata(item.user) })), nextCursor: result.nextCursor }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
