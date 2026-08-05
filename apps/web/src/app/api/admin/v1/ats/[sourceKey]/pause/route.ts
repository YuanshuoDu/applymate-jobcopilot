import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { hardRpsLimit, isAtsSourceKey } from '@/lib/admin/ats-service'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { sendWorkerCommand } from '@/lib/admin/worker-client'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

type AtsPauseResult = { state: 'paused' | 'pending_pause'; version: number; alreadyPaused?: boolean; requiresSecondApprover?: boolean; propagation: string }

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
  const existing = await db.atsSourcePolicy.findUnique({ where: { sourceKey }, select: { state: true, pauseRequestedById: true } })
  if (existing?.state === 'pending_pause' && existing.pauseRequestedById === actor.userId) return NextResponse.json({ error: 'A different administrator must approve this pause' }, { status: 403 })
  try {
    const result = await runAdminMutation<AtsPauseResult>({
      actorUserId: actor.userId,
      action: 'ats.pause',
      idempotencyKey: key,
      targetId: sourceKey,
      audit: (value) => ({ requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'ats_source', targetId: sourceKey, reason, after: { state: value.state, version: value.version }, outcome: 'success' }),
      mutate: async (tx) => {
        const policy = await tx.atsSourcePolicy.findUnique({ where: { sourceKey }, select: { state: true, pauseRequestedById: true, version: true } })
        if (policy?.state === 'paused') return { state: 'paused' as const, version: policy.version, alreadyPaused: true, propagation: 'acknowledged' }
        if (!policy) {
          const created = await tx.atsSourcePolicy.create({ data: { sourceKey, state: 'pending_pause', pauseRequestedById: actor.userId, globalRpsLimit: hardRpsLimit(sourceKey), perTenantRpsLimit: 1, version: 2, lastChangedById: actor.userId }, select: { version: true } })
          return { state: 'pending_pause' as const, version: created.version, requiresSecondApprover: true, propagation: 'pending' }
        }
        if (policy.state === 'pending_pause') {
          if (policy.pauseRequestedById === actor.userId) throw new AdminMutationConflict('A different administrator must approve this pause')
          const approved = await tx.atsSourcePolicy.update({ where: { sourceKey }, data: { state: 'paused', enabled: false, pauseApprovedById: actor.userId, lastChangedById: actor.userId, version: { increment: 1 }, lastAcknowledgedVersion: null }, select: { version: true } })
          let propagation = 'pending'
          try {
            await sendWorkerCommand({ requestId: actor.requestId, actorId: actor.userId, action: 'apply_ats_policy', reason, params: { sourceKey, version: approved.version } })
            await tx.atsSourcePolicy.update({ where: { sourceKey }, data: { lastAcknowledgedVersion: approved.version } })
            propagation = 'acknowledged'
          } catch { /* Propagation remains pending and is visible through the policy health view. */ }
          return { state: 'paused' as const, version: approved.version, alreadyPaused: false, propagation }
        }
        const requested = await tx.atsSourcePolicy.update({ where: { sourceKey }, data: { state: 'pending_pause', pauseRequestedById: actor.userId, pauseApprovedById: null, lastChangedById: actor.userId, version: { increment: 1 }, lastAcknowledgedVersion: null }, select: { version: true } })
        return { state: 'pending_pause' as const, version: requested.version, requiresSecondApprover: true, propagation: 'pending' }
      },
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
    if (result.value.state === 'pending_pause') return NextResponse.json({ state: result.value.state, requiresSecondApprover: true }, { headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json({ state: 'paused', version: result.value.version }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message }, { status: 403 })
    throw error
  }
}
