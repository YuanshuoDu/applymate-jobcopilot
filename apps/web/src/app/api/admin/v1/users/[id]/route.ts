import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { adminUserMetadataSelect, toAdminUserMetadata } from '@/lib/admin/dto'
import { db } from '@/lib/db'

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('users.read', request)
  if (isAdminResponse(actor)) return actor
  const { id } = await context.params
  const user = await db.user.findUnique({ where: { id }, select: adminUserMetadataSelect })
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const [applicationCount, recentApplications] = await Promise.all([
    db.applyResult.count({ where: { userId: id } }),
    db.applyResult.findMany({
      where: { userId: id }, take: 5, orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, mode: true, atsType: true, flowUsed: true, durationMs: true, createdAt: true },
    }),
  ])
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'users.detail_viewed', targetType: 'user', targetId: id, tenantUserId: id, outcome: 'success' })
  return NextResponse.json({ user: toAdminUserMetadata(user), applications: { count: applicationCount, recent: recentApplications } }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
