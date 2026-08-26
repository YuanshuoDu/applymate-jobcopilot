import { NextRequest, NextResponse } from 'next/server'
import { getDefaultAtsPolicy } from '@jobcopilot/shared'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { isAtsSourceKey } from '@/lib/admin/ats-service'
import { db } from '@/lib/db'

export async function GET(request: NextRequest, context: { params: Promise<{ sourceKey: string }> }) {
  const actor = await requireAdmin('ats.read', request)
  if (isAdminResponse(actor)) return actor
  const { sourceKey } = await context.params
  if (!isAtsSourceKey(sourceKey)) return NextResponse.json({ error: 'Unknown ATS source' }, { status: 404 })
  const [policy, registry] = await Promise.all([
    db.atsSourcePolicy.findUnique({ where: { sourceKey }, select: { state: true, enabled: true, rolloutPercent: true, globalRpsLimit: true, perTenantRpsLimit: true, maxRetries: true, backoffBaseMs: true, allowAutoApply: true, version: true, lastAcknowledgedVersion: true, updatedAt: true } }),
    db.atsEmployer.aggregate({ where: { atsType: sourceKey, enabled: true }, _count: { id: true }, _max: { lastSeen: true } }),
  ])
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ats.health_viewed', targetType: 'ats_source', targetId: sourceKey, outcome: 'success' })
  const effectivePolicy = policy
    ? { ...policy, configured: true }
    : { ...getDefaultAtsPolicy(sourceKey), configured: false, version: 1, lastAcknowledgedVersion: null, updatedAt: null }
  const propagation = policy
    ? policy.lastAcknowledgedVersion === policy.version ? 'acknowledged' : 'pending'
    : 'not-configured'
  return NextResponse.json({ sourceKey, credentialRequirement: 'none', registryCount: registry._count.id, lastSeenAt: registry._max.lastSeen, policy: effectivePolicy, propagation }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
