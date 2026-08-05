import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('sessions.revoke', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown; sessionVersion?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const sessionVersion = typeof payload?.sessionVersion === 'number' ? payload.sessionVersion : -1
  if (reason.length < 10 || reason.length > 500 || !Number.isInteger(sessionVersion) || !request.headers.get('idempotency-key')) return NextResponse.json({ error: 'Invalid session revocation request' }, { status: 400 })
  const updated = await db.adminMembership.updateMany({ where: { id, status: 'active', sessionVersion }, data: { sessionVersion: { increment: 1 } } })
  if (!updated.count) return NextResponse.json({ error: 'Member changed or is not active' }, { status: 409 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'sessions.revoked', targetType: 'admin_member', targetId: id, reason, outcome: 'success' })
  return NextResponse.json({ member: { id, sessionVersion: sessionVersion + 1 } }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
