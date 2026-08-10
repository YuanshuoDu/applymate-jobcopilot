import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdminAny } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { writeAdminAudit } from '@/lib/admin/audit'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdminAny(['support_cases.read', 'audit.read', 'observability.read'], request)
  if (isAdminResponse(actor)) return actor
  const take = Math.min(Math.max(Number(new URL(request.url).searchParams.get('limit') ?? '20') || 20, 1), 50)
  const [notifications, unreadCount] = await Promise.all([
    db.adminNotification.findMany({ where: { adminUserId: actor.userId }, orderBy: { createdAt: 'desc' }, take }),
    db.adminNotification.count({ where: { adminUserId: actor.userId, readAt: null } }),
  ])
  return NextResponse.json({ notifications, unreadCount }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function PATCH(request: NextRequest) {
  const actor = await requireAdminAny(['support_cases.read', 'audit.read', 'observability.read'], request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as { id?: unknown; all?: unknown } | null
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  const markAll = body?.all === true
  const key = request.headers.get('idempotency-key')?.trim()
  if ((!id && !markAll) || (id && markAll) || !key) return NextResponse.json({ error: 'Notification id or all=true and Idempotency-Key are required' }, { status: 400 })
  const where = markAll ? { adminUserId: actor.userId, readAt: null } : { id, adminUserId: actor.userId }
  const updated = await db.adminNotification.updateMany({ where, data: { readAt: new Date() } })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin_notification.marked_read', targetType: 'support_case', targetId: markAll ? 'all' : id, outcome: 'success', after: { count: updated.count } })
  const unreadCount = await db.adminNotification.count({ where: { adminUserId: actor.userId, readAt: null } })
  return NextResponse.json({ updated: updated.count, unreadCount }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
