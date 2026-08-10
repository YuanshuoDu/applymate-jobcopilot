import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { hardRpsLimit, isAtsSourceKey, parseAtsPolicy } from '@/lib/admin/ats-service'
import { acknowledgeCommittedAtsPolicy } from '@/lib/admin/ats-policy-propagation'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { sendWorkerCommand } from '@/lib/admin/worker-client'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

type AtsPolicyResult = { version: number }

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
  try {
    const result = await runAdminMutation<AtsPolicyResult>({
      actorUserId: actor.userId,
      action: 'ats.policy_updated',
      idempotencyKey: key,
      targetId: sourceKey,
      audit: (value) => ({ requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'ats_source', targetId: sourceKey, reason, after: { version: value.version, propagation: 'pending' }, outcome: 'success' }),
      mutate: async (tx) => {
        const existing = await tx.atsSourcePolicy.findUnique({ where: { sourceKey }, select: { version: true, state: true } })
        let nextVersion: number
        if (!existing) {
          if (input.version !== 1) throw new AdminMutationConflict('Policy changed or source is not editable')
          await tx.atsSourcePolicy.create({ data: { sourceKey, ...input, lastChangedById: actor.userId } })
          nextVersion = 1
        } else {
          if (!['enabled', 'degraded'].includes(existing.state) || existing.version !== input.version) throw new AdminMutationConflict('Policy changed or source is not editable')
          const updated = await tx.atsSourcePolicy.updateMany({ where: { sourceKey, version: input.version, state: { in: ['enabled', 'degraded'] } }, data: { ...input, version: { increment: 1 }, lastChangedById: actor.userId, lastAcknowledgedVersion: null } })
          if (!updated.count) throw new AdminMutationConflict('Policy changed or source is not editable')
          nextVersion = input.version + 1
        }
        return { version: nextVersion }
      },
    })
    if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
    const propagation = await acknowledgeCommittedAtsPolicy({ requestId: actor.requestId, actorId: actor.userId, sourceKey, version: result.value.version, reason }, {
      send: sendWorkerCommand,
      markAcknowledged: async (key, version) => (await db.atsSourcePolicy.updateMany({ where: { sourceKey: key, version }, data: { lastAcknowledgedVersion: version } })).count,
    })
    return NextResponse.json({ sourceKey, ...result.value, propagation }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
