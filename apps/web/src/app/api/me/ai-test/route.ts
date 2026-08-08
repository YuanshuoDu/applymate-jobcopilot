/**
 * POST /api/me/ai-test
 *
 * Tests either an explicitly supplied provider/model or the effective config
 * saved for a feature. The endpoint never returns credentials and uses
 * actionable HTTP status codes so the Settings UI can distinguish bad input,
 * missing credentials, and an upstream provider failure.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { checkDistributedRateLimit } from '@/lib/distributed-rate-limit'
import {
  APPLYMATE_BACKING,
  MODEL_CATALOGUE,
  modelChat,
  resolveConfig,
  resolveFeatureConfig,
  type AiConfig,
  type FeatureId,
  type Provider,
  type UserAiSettings,
} from '@/lib/model-router'

const PROVIDERS: readonly Provider[] = ['anthropic', 'openai', 'deepseek', 'minimax', 'qwen', 'zhipu', 'kimi', 'custom']
const FEATURES: readonly FeatureId[] = ['scoring', 'parsing', 'suggest', 'coverLetter', 'agent', 'fieldSuggest', 'interviewPrep', 'formFill', 'formRevise', 'autoApply', 'jobScoring']
const MAX_MODEL_LENGTH = 200
const MAX_BASE_LENGTH = 2_048
// Reasoning providers may spend output tokens before emitting visible content.
// A ten-token probe can therefore report a healthy key as an empty response.
const AI_TEST_MAX_TOKENS = 300

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && PROVIDERS.includes(value as Provider)
}

function isFeature(value: unknown): value is FeatureId {
  return typeof value === 'string' && FEATURES.includes(value as FeatureId)
}

function isMasked(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('••••')
}

function validBase(value: unknown, required: boolean): string | null | undefined {
  if (value === undefined || value === null || value === '') return required ? null : undefined
  if (typeof value !== 'string' || value.length > MAX_BASE_LENGTH) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    if (url.username || url.password || url.hash) return null
    return value.replace(/\/$/, '')
  } catch {
    return null
  }
}

function catalogueConfig(provider: Provider, model: string): AiConfig | null {
  const option = MODEL_CATALOGUE.find(item => item.provider === provider && item.model === model)
  if (!option) return null
  return {
    provider: option.provider,
    model: option.model,
    ...(option.defaultBase ? { apiBase: option.defaultBase } : {}),
  }
}

function safeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Provider request failed'
  return raw
    .replace(/bearer\s+[a-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[a-z0-9_-]+/gi, '[redacted]')
    .slice(0, 300)
}

function responseError(error: string, status: number, code: string) {
  return Response.json({ ok: false, code, error }, { status })
}

async function loadSettings(userId: string): Promise<UserAiSettings> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { preferences: true } })
  return (asRecord(asRecord(user?.preferences).aiSettings) as UserAiSettings)
}

function explicitConfig(body: RecordValue, settings: UserAiSettings): AiConfig | { error: string } {
  if (!isProvider(body.provider)) return { error: 'Unknown AI provider' }
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > MAX_MODEL_LENGTH) {
    return { error: 'A valid model ID is required' }
  }

  const provider = body.provider
  const model = body.model.trim()
  const base = validBase(body.apiBase, provider === 'custom')
  if (provider === 'custom' && !base) return { error: 'Custom provider requires an HTTPS endpoint' }
  if (body.apiBase !== undefined && body.apiBase !== null && body.apiBase !== '' && !base) {
    return { error: 'Invalid apiBase' }
  }

  const config = provider === 'custom'
    ? { provider, model, ...(base ? { apiBase: base } : {}) }
    : catalogueConfig(provider, model)
  if (!config) return { error: `Unknown model ${provider}/${model}` }

  const key = typeof body.apiKey === 'string' && !isMasked(body.apiKey) ? body.apiKey.trim() : ''
  const featureConfig = isFeature(body.feature) ? settings.features?.[body.feature] : null
  const featureKey = featureConfig && featureConfig.provider === provider && typeof featureConfig.apiKey === 'string'
    ? featureConfig.apiKey.trim()
    : ''
  const savedKey = featureKey || settings.keys?.[provider]?.trim() || ''
  return {
    ...config,
    ...(key || savedKey ? { apiKey: key || savedKey } : {}),
  }
}

async function effectiveConfig(body: RecordValue, userId: string): Promise<AiConfig & { resolvedKey: string } | { error: string }> {
  const feature = body.feature
  if (feature !== undefined && !isFeature(feature)) return { error: 'Unknown AI feature' }

  if (feature && body.provider === undefined && body.model === undefined && body.apiKey === undefined && body.apiBase === undefined) {
    const settings = await loadSettings(userId)
    return resolveFeatureConfig(feature, settings)
  }

  if (body.provider === undefined || body.model === undefined) {
    return { error: 'Provide provider and model, or specify a feature to test its saved configuration' }
  }

  const settings = await loadSettings(userId)
  const parsed = explicitConfig(body, settings)
  if ('error' in parsed) return parsed
  return resolveConfig(parsed)
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return responseError('Invalid JSON body', 400, 'invalid_body')
  }

  const cfg = await effectiveConfig(body as RecordValue, auth.userId)
  if ('error' in cfg) return responseError(cfg.error, 400, 'invalid_config')

  const resolved = cfg.resolvedKey?.trim()
  if (!resolved) {
    return responseError('No API key is available. Save a key or configure the platform environment.', 422, 'missing_key')
  }

  // A successful probe can use a platform-backed model. Keep this narrower
  // than normal AI work while preventing repeated Settings clicks from
  // becoming an unbounded billable endpoint.
  const rateLimit = await checkDistributedRateLimit(`ai-test:${auth.userId}:${cfg.provider}`, 3, 60_000)
  if (!rateLimit.ok) {
    if (rateLimit.unavailable) {
      return responseError('AI testing is temporarily unavailable. Please try again shortly.', 503, 'rate_limit_unavailable')
    }
    return responseError(`Rate limit exceeded — retry in ${rateLimit.retryAfter}s`, 429, 'rate_limited')
  }

  try {
    await modelChat(
      [{ role: 'user', content: 'Reply with the single word "ok".' }],
      cfg,
      AI_TEST_MAX_TOKENS,
    )
    return Response.json({ ok: true, provider: cfg.provider, model: cfg.model })
  } catch (error) {
    return responseError(safeProviderError(error), 502, 'provider_error')
  }
}
