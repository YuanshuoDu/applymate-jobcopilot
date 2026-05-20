/**
 * PATCH  /api/agent/roles/custom/[id] — update custom agent
 * DELETE /api/agent/roles/custom/[id] — delete custom agent
 */
import { NextRequest }                          from 'next/server'
import { db }                                    from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const row = await db.customAgentRole.findFirst({ where: { id, userId: auth.userId } })
  if (!row) return err('Custom agent not found', 404)

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { name, icon, description, systemPrompt, provider, model, insertAfter, enabled } = body as {
    name?: string; icon?: string; description?: string; systemPrompt?: string
    provider?: string; model?: string; insertAfter?: string; enabled?: boolean
  }

  const updated = await db.customAgentRole.update({
    where: { id },
    data: {
      ...(name         !== undefined ? { name: name.trim() }           : {}),
      ...(icon         !== undefined ? { icon: icon.trim() }           : {}),
      ...(description  !== undefined ? { description }                  : {}),
      ...(systemPrompt !== undefined ? { systemPrompt }                 : {}),
      ...(provider     !== undefined ? { provider }                     : {}),
      ...(model        !== undefined ? { model }                        : {}),
      ...(insertAfter  !== undefined ? { insertAfter }                  : {}),
      ...(enabled      !== undefined ? { enabled }                      : {}),
    },
  })

  return ok(updated)
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const row = await db.customAgentRole.findFirst({ where: { id, userId: auth.userId } })
  if (!row) return err('Custom agent not found', 404)

  await db.customAgentRole.delete({ where: { id } })
  return ok({ deleted: id })
}
