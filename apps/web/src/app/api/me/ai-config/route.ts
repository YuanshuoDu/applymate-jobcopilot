/**
 * GET  /api/me/ai-config  — get current AI settings (per-feature + per-provider keys)
 * POST /api/me/ai-config  — save AI settings
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { MODEL_CATALOGUE, type UserAiSettings, type AiConfig, type FeatureId, type Provider } from '@/lib/model-router'

/** Mask an API key for safe client display */
function maskKey(k?: string | null): string {
  if (!k) return ''
  return k.length <= 8 ? '••••' : '••••' + k.slice(-4)
}

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const user  = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
  const prefs = (user?.preferences ?? {}) as Record<string, unknown>
  const settings = (prefs.aiSettings ?? {}) as UserAiSettings

  // Mask all stored API keys before sending to client
  const maskedKeys: Partial<Record<Provider, string>> = {}
  for (const [p, k] of Object.entries(settings.keys ?? {})) {
    maskedKeys[p as Provider] = maskKey(k)
  }

  const maskedFeatures: UserAiSettings['features'] = {}
  for (const [id, cfg] of Object.entries(settings.features ?? {})) {
    maskedFeatures[id as FeatureId] = cfg
      ? { ...cfg, apiKey: cfg.apiKey ? maskKey(cfg.apiKey) : undefined }
      : null
  }

  return ok({ keys: maskedKeys, features: maskedFeatures } as UserAiSettings)
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const incoming = body as UserAiSettings

  const user  = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
  const prefs = (user?.preferences ?? {}) as Record<string, unknown>
  const existing = (prefs.aiSettings ?? {}) as UserAiSettings

  // Merge keys: keep existing (unmasked) values unless new value is provided and not a masked placeholder
  const mergedKeys: Partial<Record<Provider, string>> = { ...existing.keys }
  for (const [p, v] of Object.entries(incoming.keys ?? {})) {
    if (v && !v.startsWith('••••')) {
      // Real new key
      mergedKeys[p as Provider] = v
    } else if (!v || v === '') {
      // Explicit clear
      delete mergedKeys[p as Provider]
    }
    // Masked placeholder → keep existing
  }

  // Validate and build per-feature configs
  const mergedFeatures: UserAiSettings['features'] = { ...existing.features }
  for (const [id, cfg] of Object.entries(incoming.features ?? {})) {
    if (cfg === null) {
      // null = use ApplyMate AI default
      mergedFeatures[id as FeatureId] = null
    } else if (cfg) {
      const { provider, model } = cfg as AiConfig
      if (!provider || !model) return err(`Invalid config for feature ${id}`)
      if (provider !== 'custom') {
        const valid = MODEL_CATALOGUE.some(m => m.provider === provider && m.model === model)
        if (!valid) return err(`Unknown model ${provider}/${model} for feature ${id}`)
      }
      const newKey = (cfg as AiConfig).apiKey
      mergedFeatures[id as FeatureId] = {
        provider, model,
        ...(newKey && !newKey.startsWith('••••') ? { apiKey: newKey } : {}),
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.user.update({
    where: { id: auth.userId },
    data:  { preferences: { ...prefs, aiSettings: { keys: mergedKeys, features: mergedFeatures } } as any },
  })

  return ok({ saved: true })
}
