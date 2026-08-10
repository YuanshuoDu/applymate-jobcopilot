import { NextRequest, NextResponse } from 'next/server'
import { isAtsSourceKey } from '@jobcopilot/shared'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { db } from '@/lib/db'

export async function GET(request: NextRequest, context: { params: Promise<{ sourceKey: string }> }) {
  const actor = await requireAdmin('ats.read', request)
  if (isAdminResponse(actor)) return actor
  const { sourceKey } = await context.params
  if (!isAtsSourceKey(sourceKey)) return NextResponse.json({ error: 'Unsupported ATS source' }, { status: 400 })
  const events = await db.adminAuditLog.findMany({ where: { targetType: 'ats_source', targetId: sourceKey }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, action: true, outcome: true, reason: true, before: true, after: true, createdAt: true } })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ats.history_viewed', targetType: 'ats_source', targetId: sourceKey, outcome: 'success' })
  return NextResponse.json({ sourceKey, events }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
