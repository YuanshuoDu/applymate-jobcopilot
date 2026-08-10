import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { parseFeatureFlag } from '@/lib/admin/feature-flags'
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
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'feature_flag.updated', idempotencyKey: key, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'feature_flag', targetId: id, reason, after: { version: version + 1 }, outcome: 'success' }, mutate: (tx) => tx.platformFeatureFlag.updateMany({ where: { id, status: 'draft', version }, data: { ...input, version: { increment: 1 }, updatedById: actor.userId } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const updated = result.value
  if (!updated.count) return NextResponse.json({ error: 'Flag changed or is not a draft' }, { status: 409 })
  return NextResponse.json({ id, version: version + 1 }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
