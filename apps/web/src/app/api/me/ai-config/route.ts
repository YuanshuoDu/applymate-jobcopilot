/**
 * GET  /api/me/ai-config  - get current AI settings (masked)
 * POST /api/me/ai-config  - save AI settings
 */
import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import {
  MODEL_CATALOGUE,
  resolveFeatureConfig,
  type AiConfig,
  type FeatureId,
  type Provider,
  type UserAiSettings,
} from '@/lib/model-router'

const PROVIDERS: readonly Provider[] = ['anthropic', 'openai', 'deepseek', 'minimax', 'qwen', 'zhipu', 'kimi', 'custom']
const FEATURES: readonly FeatureId[] = ['scoring', 'parsing', 'suggest', 'coverLetter', 'agent', 'fieldSuggest', 'interviewPrep', 'formFill', 'formRevise', 'autoApply', 'jobScoring']
const MAX_KEY_LENGTH = 4_096
const MAX_MODEL_LENGTH = 200
const MAX_BASE_LENGTH = 2_048

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && PROVIDERS.includes(value as Provider)
}

function isFeature(value: string): value is FeatureId {
  return FEATURES.includes(value as FeatureId)
}

function maskKey(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`
}

function isMasked(value: string): boolean {
  return value.startsWith('••••')
}

function validateBase(value: unknown, required: boolean): string | null | undefined {
  if (value === undefined) return required ? null : undefined
  if (value === null || value === '') return required ? null : undefined
  if (typeof value !== 'string' || value.length > MAX_BASE_LENGTH) return null
  try {
    const url = new URL(value)
    const localDev = process.env.NODE_ENV !== 'production' && url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    if (url.protocol !== 'https:' && !localDev) return null
    if (url.username || url.password || url.hash) return null
    return value.replace(/\/$/, '')
  } catch {
    return null
  }
}

function parseFeatureConfig(raw: unknown, feature: string, previous: unknown): { config: AiConfig | null } | { error: string } {
  if (raw === null) return { config: null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `Invalid config for feature ${feature}` }

  const input = raw as RecordValue
  const unknownFields = Object.keys(input).filter(key => !['provider', 'model', 'apiKey', 'apiBase', 'thinking'].includes(key))
  if (unknownFields.length > 0) return { error: `Unsupported field for feature ${feature}` }
  if (!isProvider(input.provider) || typeof input.model !== 'string' || !input.model.trim() || input.model.length > MAX_MODEL_LENGTH) {
    return { error: `Invalid config for feature ${feature}` }
  }

  const provider = input.provider
  const model = input.model.trim()
  if (provider !== 'custom' && !MODEL_CATALOGUE.some(option => option.provider === provider && option.model === model)) {
    return { error: `Unknown model ${provider}/${model} for feature ${feature}` }
  }

  const isCustomProvider = provider === 'custom'
  const hasApiBase = input.apiBase !== undefined && input.apiBase !== null && input.apiBase !== ''
  if (!isCustomProvider && hasApiBase) return { error: `apiBase is only supported for the custom provider (${feature})` }

  const old = asRecord(previous)
  const inheritedBase = isCustomProvider && input.apiBase === undefined && old.provider === provider && typeof old.apiBase === 'string'
    ? old.apiBase
    : undefined
  const base = validateBase(isCustomProvider ? (input.apiBase === undefined ? inheritedBase : input.apiBase) : undefined, isCustomProvider)
  if (isCustomProvider && !base) return { error: `Custom provider for ${feature} requires an HTTPS apiBase` }

  let apiKey: string | undefined
  let clearPreviousKey = false
  let maskedInputKey = false
  if (input.apiKey !== undefined && input.apiKey !== null) {
    if (typeof input.apiKey !== 'string' || input.apiKey.length > MAX_KEY_LENGTH) return { error: `Invalid apiKey for feature ${feature}` }
    const normalizedKey = input.apiKey.trim()
    clearPreviousKey = normalizedKey === ''
    maskedInputKey = isMasked(normalizedKey)
    if (normalizedKey && !maskedInputKey) apiKey = normalizedKey
  }
  const previousKey = old.provider === provider && typeof old.apiKey === 'string' ? old.apiKey : undefined
  if (apiKey === undefined && !clearPreviousKey && (input.apiKey === undefined || maskedInputKey) && previousKey && !isMasked(previousKey)) apiKey = previousKey

  const config: AiConfig = { provider, model, ...(apiKey ? { apiKey } : {}), ...(base ? { apiBase: base } : {}) }
  if (input.thinking !== undefined) {
    if (input.thinking !== 'adaptive' && input.thinking !== 'disabled') return { error: `Invalid thinking mode for feature ${feature}` }
    config.thinking = input.thinking
  } else if (old.thinking === 'adaptive' || old.thinking === 'disabled') {
    config.thinking = old.thinking
  }
  return { config }
}

function maskedSettings(value: unknown): UserAiSettings {
  const source = asRecord(value)
  const keys: Partial<Record<Provider, string>> = {}
  for (const [provider, key] of Object.entries(asRecord(source.keys))) {
    if (isProvider(provider) && typeof key === 'string' && key) keys[provider] = maskKey(key)
  }

  const features: Partial<Record<FeatureId, AiConfig | null>> = {}
  for (const [feature, raw] of Object.entries(asRecord(source.features))) {
    if (!isFeature(feature)) continue
    if (raw === null) {
      features[feature] = null
      continue
    }
    const config = asRecord(raw)
    if (!isProvider(config.provider) || typeof config.model !== 'string') continue
    features[feature] = {
      provider: config.provider,
      model: config.model,
      ...(typeof config.apiBase === 'string' ? { apiBase: config.apiBase } : {}),
      ...(config.thinking === 'adaptive' || config.thinking === 'disabled' ? { thinking: config.thinking } : {}),
      ...(typeof config.apiKey === 'string' && config.apiKey ? { apiKey: maskKey(config.apiKey) } : {}),
    }
  }
  return { keys, features }
}

function platformStatus() {
  // Presence only: never send the platform credential to a candidate client.
  return { minimax: Boolean(process.env.MINIMAX_API_KEY?.trim()) }
}

function legacyFeature(body: RecordValue): RecordValue | null {
  if (body.provider === undefined && body.model === undefined && body.apiKey === undefined && body.apiBase === undefined && body.thinking === undefined) return null
  return {
    ...(body.provider !== undefined ? { provider: body.provider } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
    ...(body.apiBase !== undefined ? { apiBase: body.apiBase } : {}),
    ...(body.thinking !== undefined ? { thinking: body.thinking } : {}),
  }
}

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const user = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
  const prefs = asRecord(user?.preferences)
  return ok({ ...maskedSettings(prefs.aiSettings), platform: platformStatus() })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err('Invalid JSON body')
  const input = body as RecordValue
  const user = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
  if (!user) return err('User not found', 404)

  const prefs = asRecord(user.preferences)
  const existing = asRecord(prefs.aiSettings)
  const mergedKeys: Partial<Record<Provider, string>> = {}
  for (const [provider, key] of Object.entries(asRecord(existing.keys))) {
    if (isProvider(provider) && typeof key === 'string' && key) mergedKeys[provider] = key
  }

  if (input.keys !== undefined && (typeof input.keys !== 'object' || input.keys === null || Array.isArray(input.keys))) return err('keys must be an object')
  for (const [provider, raw] of Object.entries(asRecord(input.keys))) {
    if (!isProvider(provider)) return err(`Unknown AI provider ${provider}`)
    if (raw === null || raw === '') {
      delete mergedKeys[provider]
      continue
    }
    if (typeof raw !== 'string' || raw.length > MAX_KEY_LENGTH) return err(`Invalid API key for ${provider}`)
    const normalizedKey = raw.trim()
    if (!normalizedKey) {
      delete mergedKeys[provider]
      continue
    }
    if (!isMasked(normalizedKey)) mergedKeys[provider] = normalizedKey
  }

  if (input.features !== undefined && (typeof input.features !== 'object' || input.features === null || Array.isArray(input.features))) return err('features must be an object')
  const incomingFeatures = { ...asRecord(input.features) }
  const legacy = legacyFeature(input)
  if (legacy) incomingFeatures.agent = legacy
  const mergedFeatures: Record<string, unknown> = { ...asRecord(existing.features) }
  for (const [feature, raw] of Object.entries(incomingFeatures)) {
    if (!isFeature(feature)) return err(`Unknown AI feature ${feature}`)
    const parsed = parseFeatureConfig(raw, feature, mergedFeatures[feature])
    if ('error' in parsed) return err(parsed.error)
    mergedFeatures[feature] = parsed.config
  }
  if (legacy) {
    const agent = mergedFeatures.agent
    mergedFeatures.autoApply = agent === null
      ? null
      : agent && typeof agent === 'object'
        ? { ...(agent as AiConfig) }
        : null
  }

  const nextFeatures: UserAiSettings['features'] = {}
  for (const feature of FEATURES) {
    const value = mergedFeatures[feature]
    if (value === null) nextFeatures[feature] = null
    else if (value && typeof value === 'object') nextFeatures[feature] = value as AiConfig
  }
  const nextSettings: UserAiSettings = { keys: mergedKeys, features: nextFeatures }
  const updatedFeatures = legacy
    ? [...Object.keys(incomingFeatures), 'autoApply']
    : Object.keys(incomingFeatures)
  for (const feature of updatedFeatures) {
    if (!isFeature(feature)) continue
    const selected = nextFeatures[feature]
    const effective = resolveFeatureConfig(feature, nextSettings)
    if (!effective.resolvedKey) {
      const provider = selected?.provider ?? effective.provider
      return err(`No API key is available for ${provider}. Save a key or configure the platform provider before assigning ${feature}.`, 422)
    }
  }

  const updated = await db.user.update({
    where: { id: auth.userId },
    data: { preferences: { ...prefs, aiSettings: { keys: mergedKeys, features: mergedFeatures } } as Prisma.InputJsonValue },
    select: { preferences: true },
  })
  return ok({ saved: true, settings: { ...maskedSettings(asRecord(updated.preferences).aiSettings), platform: platformStatus() } })
}
