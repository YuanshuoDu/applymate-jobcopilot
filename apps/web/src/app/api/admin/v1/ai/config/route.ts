import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { getAiAdminConfig } from '@/lib/admin/ai-config'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'
import { fixedSecretRef } from '@/lib/admin/ai-config'
import { isSafeAiEndpoint } from '@jobcopilot/shared/safe-ai-endpoint'

function text(value: unknown, max: number) { return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null }
function numberValue(value: unknown, min: number, max: number) { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null }

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('ai_budget.read', request)
  if (isAdminResponse(actor)) return actor
  return NextResponse.json(await getAiAdminConfig(), { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function PATCH(request: NextRequest) {
  const actor = await requireAdmin('ai_budget.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as Record<string, unknown> | null ?? {}
  const type = body?.type
  const reason = text(body?.reason, 500)
  const idempotencyKey = request.headers.get('idempotency-key')
  if (!reason || reason.length < 10 || !idempotencyKey) return NextResponse.json({ error: 'A reason and Idempotency-Key are required' }, { status: 400 })

  let action = 'ai_config.updated'
  let targetType: 'ai_provider' | 'ai_model' | 'ai_route' = 'ai_route'
  let targetId: string | undefined
  let mutate: Parameters<typeof runAdminMutation>[0]['mutate']
  if (type === 'provider') {
    const key = text(body?.key, 60); const displayName = text(body?.displayName, 80); const apiBase = text(body?.apiBase, 240)
    const secretRef = key ? fixedSecretRef(key) : null
    const enabled = typeof body?.enabled === 'boolean' ? body.enabled : null
    if (!key || !displayName || !apiBase || enabled === null || !isSafeAiEndpoint(apiBase)) return NextResponse.json({ error: 'Invalid provider config' }, { status: 400 })
    action = 'ai_provider.updated'; targetType = 'ai_provider'; targetId = typeof body.id === 'string' ? body.id : key
    mutate = tx => body.id
      ? tx.aiProviderConfig.update({ where: { id: body.id as string }, data: { displayName, apiBase, secretRef, enabled, version: { increment: 1 } } })
      : tx.aiProviderConfig.create({ data: { key, displayName, apiBase, secretRef, enabled } })
  } else if (type === 'model') {
    const providerId = text(body?.providerId, 80); const model = text(body?.model, 120); const label = text(body?.label, 120); const description = text(body?.description, 240) ?? ''; const tier = text(body?.tier, 30)
    const priceIn = numberValue(body?.priceIn, 0, 1_000_000); const priceOut = numberValue(body?.priceOut, 0, 1_000_000); const contextK = numberValue(body?.contextK, 1, 100_000); const active = typeof body?.active === 'boolean' ? body.active : null
    if (!providerId || !model || !label || !tier || priceIn === null || priceOut === null || contextK === null || active === null) return NextResponse.json({ error: 'Invalid model config' }, { status: 400 })
    action = 'ai_model.updated'; targetType = 'ai_model'; targetId = typeof body.id === 'string' ? body.id : model
    mutate = tx => body.id
      ? tx.aiModelConfig.update({ where: { id: body.id as string }, data: { model, label, description, tier, priceIn, priceOut, contextK: Math.trunc(contextK), active } })
      : tx.aiModelConfig.create({ data: { providerId, model, label, description, tier, priceIn, priceOut, contextK: Math.trunc(contextK), active } })
  } else if (type === 'route') {
    const featureKey = text(body?.featureKey, 80); const defaultProvider = text(body?.defaultProvider, 60); const defaultModel = text(body?.defaultModel, 120)
    const fallbackProvider = body?.fallbackProvider ? text(body.fallbackProvider, 60) : null; const fallbackModel = body?.fallbackModel ? text(body.fallbackModel, 120) : null
    if (!featureKey || !defaultProvider || !defaultModel || (body?.fallbackProvider && !fallbackProvider) || (body?.fallbackModel && !fallbackModel)) return NextResponse.json({ error: 'Invalid AI route' }, { status: 400 })
    targetId = featureKey
    mutate = tx => tx.aiRouteConfig.upsert({ where: { featureKey }, create: { featureKey, defaultProvider, defaultModel, fallbackProvider, fallbackModel, updatedById: actor.userId }, update: { defaultProvider, defaultModel, fallbackProvider, fallbackModel, updatedById: actor.userId, version: { increment: 1 } } })
  } else return NextResponse.json({ error: 'type must be provider, model, or route' }, { status: 400 })

  const result = await runAdminMutation({ actorUserId: actor.userId, action, idempotencyKey, targetId, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType, targetId, reason, outcome: 'success' }, mutate })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ config: await getAiAdminConfig() }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
