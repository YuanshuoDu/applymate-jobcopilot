/**
 * GET  /api/agent/roles  — get all 6 role configs for current user
 * PATCH /api/agent/roles — bulk update one or more roles
 *
 * PATCH body: { [role]: { provider, model, apiKey?, enabled? }, … }
 */
import { NextRequest }                      from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { loadRoleConfigs, upsertRoleConfig, AGENT_ROLES } from '@/lib/agent/role-config'
import type { AgentRoleType }              from '@/lib/agent/role-config'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const roles = await loadRoleConfigs(auth.userId)
  return ok(roles)
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return err('Invalid JSON body')

  const updated = []
  for (const role of AGENT_ROLES) {
    if (!(role in body)) continue
    const patch = body[role as string] as {
      provider?: string; model?: string; apiKey?: string | null; enabled?: boolean
    }
    const result = await upsertRoleConfig(auth.userId, role as AgentRoleType, {
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model    !== undefined ? { model:    patch.model    } : {}),
      ...(patch.apiKey   !== undefined ? { apiKey:   patch.apiKey ?? undefined } : {}),
      ...(patch.enabled  !== undefined ? { enabled:  patch.enabled  } : {}),
    })
    updated.push(result)
  }

  return ok(updated)
}
