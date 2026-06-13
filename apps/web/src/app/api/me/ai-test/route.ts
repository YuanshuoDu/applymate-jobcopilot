/**
 * POST /api/me/ai-test
 * Body: { provider, model, apiKey?, apiBase? }
 * Tests connectivity to the given provider with a minimal prompt.
 * Returns: { ok: true } | { ok: false, error: string }
 */
import { NextRequest }             from 'next/server'
import { requireAuth, isErrorResponse } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { modelChat, resolveConfig, type AiConfig, type UserAiSettings } from '@/lib/model-router'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body?.provider || !body?.model) {
    return Response.json({ ok: false, error: 'Missing provider or model' }, { status: 400 })
  }

  const provider = body.provider as AiConfig['provider']
  let savedKey: string | undefined
  if (!body.apiKey) {
    const user = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
    const prefs = (user?.preferences ?? {}) as Record<string, unknown>
    const settings = (prefs.aiSettings ?? {}) as UserAiSettings
    savedKey = settings.keys?.[provider]
  }

  const cfg: AiConfig = {
    provider: body.provider,
    model:    body.model,
    apiKey:   body.apiKey  ?? savedKey ?? undefined,
    apiBase:  body.apiBase ?? undefined,
  }

  // Resolve key — if still empty after resolveConfig, give a clear error early
  const resolved = resolveConfig(cfg)
  if (!resolved.resolvedKey) {
    return Response.json({ ok: false, error: '未找到 API Key，请先填写并保存后再测试' })
  }

  try {
    await modelChat(
      [{ role: 'user', content: 'Reply with the single word "ok".' }],
      cfg,
      10,
    )
    return Response.json({ ok: true, provider: cfg.provider, model: cfg.model })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message.slice(0, 300) })
  }
}
