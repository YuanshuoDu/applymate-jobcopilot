import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { parseFeatureFlag } from '@/lib/admin/feature-flags'
import { claimAdminIdempotencyKey } from '@/lib/admin/idempotency'
import { db } from '@/lib/db'

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('feature_flags.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown; version?: unknown } | null
  const input = parseFeatureFlag(payload)
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const version = typeof payload?.version === 'number' && Number.isInteger(payload.version) ? payload.version : -1
  const key = request.headers.get('idempotency-key')
  if (!input || version < 1 || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid flag update' }, { status: 400 })
  if (!await claimAdminIdempotencyKey(actor.userId, 'feature_flag.updated', key, id)) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const updated = await db.platformFeatureFlag.updateMany({ where: { id, status: 'draft', version }, data: { ...input, version: { increment: 1 }, updatedById: actor.userId } })
  if (!updated.count) return NextResponse.json({ error: 'Flag changed or is not a draft' }, { status: 409 })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'feature_flag.updated', targetType: 'feature_flag', targetId: id, reason, after: { version: version + 1 }, outcome: 'success' })
  return NextResponse.json({ id, version: version + 1 }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
