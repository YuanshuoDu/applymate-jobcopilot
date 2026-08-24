import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { db } from '@/lib/db'
import { fixedSecretRef } from '@/lib/admin/ai-config'
import { isSafeAiEndpoint } from '@jobcopilot/shared/safe-ai-endpoint'
import { pinnedFetch } from '@jobcopilot/shared'
import { recordAiUsage } from '@/lib/ai-usage'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const actor = await requireAdmin('ai_budget.update', request)
  if (isAdminResponse(actor)) return actor
  const { id } = await params
  const provider = await db.aiProviderConfig.findUnique({ where: { id }, select: { key: true, apiBase: true, secretRef: true, enabled: true } })
  if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  const secretRef = fixedSecretRef(provider.key)
  if (!secretRef || !isSafeAiEndpoint(provider.apiBase)) {
    return NextResponse.json({ error: 'Provider endpoint or credential mapping is not approved' }, { status: 409 })
  }
  const secret = process.env[secretRef]
  if (!provider.enabled) return NextResponse.json({ error: 'Provider is disabled' }, { status: 409 })
  if (!secret) return NextResponse.json({ status: 'missing_credential', credentialConfigured: false, secretRef }, { headers: { 'Cache-Control': 'no-store' } })
  const started = Date.now()
  let status = 'ok'; let httpStatus: number | null = null
  try {
    const response = await pinnedFetch(`${provider.apiBase.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${secret}` }, cache: 'no-store', signal: AbortSignal.timeout(5_000) })
    httpStatus = response.status
    status = response.ok ? 'ok' : response.status === 401 || response.status === 403 ? 'invalid_credential' : 'provider_error'
  } catch { status = 'timeout_or_unreachable' }
  await recordAiUsage({ userId: actor.userId, featureKey: 'providerTest', provider: provider.key, model: 'models-catalog', credentialSource: 'platform', latencyMs: Date.now() - started, status: status === 'ok' ? 'success' : 'error', errorCode: status === 'ok' ? undefined : status })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'ai_provider.connection_tested', targetType: 'ai_provider', targetId: id, reason: 'Testing provider reachability without persisting credentials', outcome: status === 'ok' ? 'success' : 'failed', errorCode: status === 'ok' ? undefined : status })
  return NextResponse.json({ status, httpStatus, latencyMs: Date.now() - started, credentialConfigured: true }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
