import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { isAtsSourceKey } from '@/lib/admin/ats-service'
import { acknowledgeCommittedAtsPolicy } from '@/lib/admin/ats-policy-propagation'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { sendWorkerCommand } from '@/lib/admin/worker-client'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

type AtsResumeResult = { state: 'enabled'; version: number }

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
  try {
    const result = await runAdminMutation<AtsResumeResult>({
      actorUserId: actor.userId,
      action: 'ats.resumed',
      idempotencyKey: key,
      targetId: sourceKey,
      audit: (value) => ({ requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'ats_source', targetId: sourceKey, reason, after: { version: value.version, propagation: 'pending' }, outcome: 'success' }),
      mutate: async (tx) => {
        const updated = await tx.atsSourcePolicy.updateMany({ where: { sourceKey, state: 'paused', version }, data: { state: 'enabled', enabled: true, lastChangedById: actor.userId, pauseRequestedById: null, pauseApprovedById: null, version: { increment: 1 }, lastAcknowledgedVersion: null } })
        if (!updated.count) throw new AdminMutationConflict('Policy changed, is not paused, or requires a current version')
        return { state: 'enabled' as const, version: version + 1 }
      },
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
    const propagation = await acknowledgeCommittedAtsPolicy({ requestId: actor.requestId, actorId: actor.userId, sourceKey, version: result.value.version, reason }, {
      send: sendWorkerCommand,
      markAcknowledged: async (key, acknowledgedVersion) => (await db.atsSourcePolicy.updateMany({ where: { sourceKey: key, version: acknowledgedVersion }, data: { lastAcknowledgedVersion: acknowledgedVersion } })).count,
    })
    return NextResponse.json({ state: result.value.state, version: result.value.version, propagation }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
