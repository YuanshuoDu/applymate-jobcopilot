/**
 * GET   /api/agent/roles/[role]  — get single role config
 * PATCH /api/agent/roles/[role]  — update single role config
 */
import { NextRequest }                      from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { upsertRoleConfig, loadRoleConfigs, AGENT_ROLES } from '@/lib/agent/role-config'
import type { AgentRoleType }              from '@/lib/agent/role-config'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ role: string }> },
) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { role } = await params
  if (!AGENT_ROLES.includes(role as AgentRoleType)) return err(`Unknown role: ${role}`)

  const roles = await loadRoleConfigs(auth.userId)
  const found = roles.find(r => r.role === role)
  return ok(found ?? null)
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ role: string }> },
) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { role } = await params
  if (!AGENT_ROLES.includes(role as AgentRoleType)) return err(`Unknown role: ${role}`)

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { provider, model, apiKey, enabled, systemPrompt } = body as {
    provider?: string; model?: string; apiKey?: string | null; enabled?: boolean; systemPrompt?: string | null
  }

  const updated = await upsertRoleConfig(auth.userId, role as AgentRoleType, {
    ...(provider     !== undefined ? { provider }                           : {}),
    ...(model        !== undefined ? { model }                              : {}),
    ...(apiKey       !== undefined ? { apiKey: apiKey ?? undefined }        : {}),
    ...(enabled      !== undefined ? { enabled }                            : {}),
    ...(systemPrompt !== undefined ? { systemPrompt: systemPrompt ?? null } : {}),
  })

  return ok(updated)
}
