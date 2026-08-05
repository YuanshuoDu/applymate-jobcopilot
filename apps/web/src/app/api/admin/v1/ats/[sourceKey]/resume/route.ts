import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { isAtsSourceKey } from '@/lib/admin/ats-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { claimAdminIdempotencyKey } from '@/lib/admin/idempotency'
import { sendWorkerCommand } from '@/lib/admin/worker-client'
import { db } from '@/lib/db'

export async function POST(request: NextRequest, context: { params: Promise<{ sourceKey: string }> }) {
  const actor = await requireAdmin('ats.resume', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { sourceKey } = await context.params
  const payload = await request.json().catch(() => null) as { reason?: unknown; version?: unknown } | null
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : ''
  const version = typeof payload?.version === 'number' ? payload.version : -1
  const key = request.headers.get('idempotency-key')
  if (!isAtsSourceKey(sourceKey) || !Number.isInteger(version) || reason.length < 10 || reason.length > 500 || !key) return NextResponse.json({ error: 'Invalid resume request' }, { status: 400 })
  if (!await claimAdminIdempotencyKey(actor.userId, 'ats.resume', key, sourceKey)) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ats.resume_requested', targetType: 'ats_source', targetId: sourceKey, reason, outcome: 'success' })
  const updated = await db.atsSourcePolicy.updateMany({ where: { sourceKey, state: 'paused', version }, data: { state: 'enabled', enabled: true, lastChangedById: actor.userId, pauseRequestedById: null, pauseApprovedById: null, version: { increment: 1 }, lastAcknowledgedVersion: null } })
  if (!updated.count) return NextResponse.json({ error: 'Policy changed, is not paused, or requires a current version' }, { status: 409 })
  try { await sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: 'apply_ats_policy', reason, params: { sourceKey, version: version + 1 } }); await db.atsSourcePolicy.update({ where: { sourceKey }, data: { lastAcknowledgedVersion: version + 1 } }) } catch { /* Safe local state remains pending propagation. */ }
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ats.resumed', targetType: 'ats_source', targetId: sourceKey, reason, after: { version: version + 1 }, outcome: 'success' })
  return NextResponse.json({ state: 'enabled', version: version + 1 }, { headers: { 'Cache-Control': 'no-store' } })
}
