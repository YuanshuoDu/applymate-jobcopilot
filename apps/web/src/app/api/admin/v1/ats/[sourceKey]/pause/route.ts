import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { hardRpsLimit, isAtsSourceKey } from '@/lib/admin/ats-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { claimAdminIdempotencyKey } from '@/lib/admin/idempotency'
import { sendWorkerCommand } from '@/lib/admin/worker-client'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ sourceKey: string }> }) {
  const actor = await requireAdmin('ats.pause', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { sourceKey } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const key = request.headers.get('idempotency-key')
  if (!isAtsSourceKey(sourceKey) || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid pause request' }, { status: 400 })
  if (!await claimAdminIdempotencyKey(actor.userId, 'ats.pause', key, sourceKey)) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  const existing = await db.atsSourcePolicy.findUnique({ where: { sourceKey }, select: { state: true, pauseRequestedById: true } })
  const policy = existing ?? await db.atsSourcePolicy.create({ data: { sourceKey, globalRpsLimit: hardRpsLimit(sourceKey), perTenantRpsLimit: 1, lastChangedById: actor.userId } })
  if (policy.state === 'paused') return NextResponse.json({ state: 'paused', duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  if (policy.state !== 'pending_pause') {
    await db.atsSourcePolicy.update({ where: { sourceKey }, data: { state: 'pending_pause', pauseRequestedById: actor.userId, pauseApprovedById: null, lastChangedById: actor.userId, version: { increment: 1 }, lastAcknowledgedVersion: null } })
    await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ats.pause_requested', targetType: 'ats_source', targetId: sourceKey, reason, outcome: 'success' })
    return NextResponse.json({ state: 'pending_pause', requiresSecondApprover: true }, { headers: { 'Cache-Control': 'no-store' } })
  }
  if (policy.pauseRequestedById === actor.userId) return NextResponse.json({ error: 'A different administrator must approve this pause' }, { status: 403 })
  const updated = await db.atsSourcePolicy.update({ where: { sourceKey }, data: { state: 'paused', enabled: false, pauseApprovedById: actor.userId, lastChangedById: actor.userId, version: { increment: 1 }, lastAcknowledgedVersion: null } })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ats.paused', targetType: 'ats_source', targetId: sourceKey, reason, after: { version: updated.version }, outcome: 'success' })
  try { await sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: 'apply_ats_policy', reason, params: { sourceKey, version: updated.version } }); await db.atsSourcePolicy.update({ where: { sourceKey }, data: { lastAcknowledgedVersion: updated.version } }) } catch { /* Propagation remains pending. */ }
  return NextResponse.json({ state: 'paused', version: updated.version }, { headers: { 'Cache-Control': 'no-store' } })
}
