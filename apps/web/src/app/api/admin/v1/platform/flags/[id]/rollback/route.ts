import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { claimAdminIdempotencyKey } from '@/lib/admin/idempotency'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('feature_flags.approve', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown; version?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const version = typeof payload?.version === 'number' && Number.isInteger(payload.version) ? payload.version : -1
  const key = request.headers.get('idempotency-key')
  if (version < 1 || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid rollback request' }, { status: 400 })
  const flag = await db.platformFeatureFlag.findUnique({ where: { id }, select: { createdById: true } })
  if (!flag) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (flag.createdById === actor.userId) return NextResponse.json({ error: 'Creator cannot approve their own rollback' }, { status: 403 })
  if (!await claimAdminIdempotencyKey(actor.userId, 'feature_flag.rolled_back', key, id)) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'feature_flag.rollback_requested', targetType: 'feature_flag', targetId: id, reason, outcome: 'success' })
  const updated = await db.platformFeatureFlag.updateMany({ where: { id, status: 'active', version }, data: { enabled: false, status: 'retired', updatedById: actor.userId, version: { increment: 1 } } })
  if (!updated.count) return NextResponse.json({ error: 'Flag changed or is not active' }, { status: 409 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'feature_flag.rolled_back', targetType: 'feature_flag', targetId: id, reason, after: { version: version + 1 }, outcome: 'success' })
  return NextResponse.json({ id, status: 'retired', version: version + 1 }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
