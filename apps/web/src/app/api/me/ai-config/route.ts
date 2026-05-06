/**
 * GET  /api/me/ai-config  — get current AI model config
 * POST /api/me/ai-config  — save AI model config
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { MODEL_CATALOGUE, DEFAULT_AI_CONFIG, type AiConfig } from '@/lib/model-router'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const user  = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
  const prefs = (user?.preferences ?? {}) as Record<string, unknown>
  const cfg   = (prefs.aiConfig ?? DEFAULT_AI_CONFIG) as AiConfig

  // Mask the API key — return only last 4 chars
  const masked = cfg.apiKey
    ? { ...cfg, apiKey: '••••' + cfg.apiKey.slice(-4) }
    : cfg

  return ok(masked)
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { provider, model, apiKey, apiBase } = body as AiConfig

  if (!provider) return err('provider is required')
  if (!model)    return err('model is required')

  // Validate provider+model combo (custom is always allowed)
  if (provider !== 'custom') {
    const valid = MODEL_CATALOGUE.some(m => m.provider === provider && m.model === model)
    if (!valid) return err(`Unknown model: ${provider}/${model}`)
  }

  const user  = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
  const prefs = (user?.preferences ?? {}) as Record<string, unknown>

  const newCfg: AiConfig = {
    provider,
    model,
    ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
    ...(apiBase?.trim() ? { apiBase: apiBase.trim() } : {}),
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.user.update({
    where: { id: auth.userId },
    data:  { preferences: { ...prefs, aiConfig: newCfg } as any },
  })

  return ok({ saved: true, provider, model })
}
