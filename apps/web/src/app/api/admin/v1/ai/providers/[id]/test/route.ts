import { db } from '@/lib/db'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { modelChat, type AiConfig, type Provider } from '@/lib/model-router'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason, requireAdminActor } from '@/lib/admin/route-utils'

const KNOWN_PROVIDERS = new Set<Provider>(['anthropic', 'openai', 'deepseek', 'minimax', 'qwen', 'zhipu', 'kimi', 'custom'])

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdminActor('ai_budget.update', request); const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId)
    const { id } = await context.params; const body = await jsonBody(request); const reason = requiredReason(body); const provider = await db.aiProviderConfig.findUnique({ where: { id }, select: { id: true, key: true, apiBase: true, secretRef: true, enabled: true, models: { where: { active: true }, orderBy: { model: 'asc' }, select: { model: true } } } }); if (!provider) return adminJson({ error: 'AI_PROVIDER_NOT_FOUND' }, 404, correlationId); if (!provider.enabled) return adminJson({ error: 'AI_PROVIDER_DISABLED' }, 409, correlationId); if (!KNOWN_PROVIDERS.has(provider.key as Provider)) return adminJson({ error: 'AI_PROVIDER_UNSUPPORTED' }, 422, correlationId)
    const model = typeof body.model === 'string' && provider.models.some(item => item.model === body.model) ? body.model : provider.models[0]?.model; if (!model) return adminJson({ error: 'AI_MODEL_NOT_FOUND' }, 422, correlationId)
    const secret = provider.secretRef ? process.env[provider.secretRef] : undefined; if (!secret) return adminJson({ error: 'AI_CREDENTIAL_NOT_CONFIGURED' }, 422, correlationId)
    const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.ai.provider.test', body: { id, model, reason } }, async transaction => {
      const started = Date.now(); let result: { provider: Provider; model: string }
      try { const config: AiConfig = { provider: provider.key as Provider, model, apiBase: provider.apiBase, apiKey: secret }; const output = await modelChat([{ role: 'user', content: 'Respond with the single word OK.' }], config, 16); result = { provider: output.provider, model: output.model } } catch (error) { const message = error instanceof Error ? error.message.slice(0, 180) : 'Provider test failed'; await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.ai.provider.test', targetType: 'ai_provider', targetId: id, reason, outcome: 'failed', after: { status: 'failed', errorClass: classifyError(message) } }); return { status: 200, body: { ok: false, provider: provider.key, model, latencyMs: Date.now() - started, errorClass: classifyError(message) } } }
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.ai.provider.test', targetType: 'ai_provider', targetId: id, reason, outcome: 'success', after: { status: 'ok', model: result.model, latencyMs: Date.now() - started } })
      return { status: 200, body: { ok: true, provider: result.provider, model: result.model, latencyMs: Date.now() - started } }
    })
    return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}

function classifyError(message: string): string { const lower = message.toLowerCase(); if (lower.includes('timeout') || lower.includes('abort')) return 'timeout'; if (lower.includes('401') || lower.includes('403') || lower.includes('api key')) return 'authentication'; if (lower.includes('429')) return 'rate_limited'; return 'provider_error' }
