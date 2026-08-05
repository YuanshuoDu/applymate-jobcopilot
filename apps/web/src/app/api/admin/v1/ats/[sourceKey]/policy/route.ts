import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { hardRpsLimit, isAtsSourceKey, parseAtsPolicy } from '@/lib/admin/ats-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { claimAdminIdempotencyKey } from '@/lib/admin/idempotency'
import { sendWorkerCommand } from '@/lib/admin/worker-client'
import { db } from '@/lib/db'

export async function PATCH(request: NextRequest, context: { params: Promise<{ sourceKey: string }> }) {
  const actor = await requireAdmin('ats.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { sourceKey } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const input = parseAtsPolicy(payload)
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!isAtsSourceKey(sourceKey) || !input || input.globalRpsLimit > hardRpsLimit(sourceKey) || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid ATS policy update' }, { status: 400 })
  if (!await claimAdminIdempotencyKey(actor.userId, 'ats.policy_updated', key, sourceKey)) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ats.policy_update_requested', targetType: 'ats_source', targetId: sourceKey, reason, outcome: 'success' })
  const existing = await db.atsSourcePolicy.findUnique({ where: { sourceKey }, select: { id: true } })
  const policy = existing
    ? await db.atsSourcePolicy.updateMany({ where: { sourceKey, version: input.version, state: { in: ['enabled', 'degraded'] } }, data: { ...input, version: { increment: 1 }, lastChangedById: actor.userId, lastAcknowledgedVersion: null } })
    : input.version === 1 ? { count: await db.atsSourcePolicy.create({ data: { sourceKey, ...input, lastChangedById: actor.userId } }).then(() => 1) } : { count: 0 }
  if (!policy.count) return NextResponse.json({ error: 'Policy changed or source is not editable' }, { status: 409 })
  const nextVersion = existing ? input.version + 1 : 1
  let propagation = 'pending'
  try {
    await sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: 'apply_ats_policy', reason, params: { sourceKey, version: nextVersion } })
    await db.atsSourcePolicy.update({ where: { sourceKey }, data: { lastAcknowledgedVersion: nextVersion } })
    propagation = 'acknowledged'
  } catch { /* Policy remains safe and visibly pending until the worker reconnects. */ }
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ats.policy_updated', targetType: 'ats_source', targetId: sourceKey, reason, after: { version: nextVersion, propagation }, outcome: 'success' })
  return NextResponse.json({ sourceKey, version: nextVersion, propagation }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
