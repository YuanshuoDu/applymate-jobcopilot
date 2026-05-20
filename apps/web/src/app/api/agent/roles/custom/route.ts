/**
 * GET  /api/agent/roles/custom — list custom agents for current user
 * POST /api/agent/roles/custom — create a new custom agent
 */
import { NextRequest }                          from 'next/server'
import { db }                                    from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth
  const rows = await db.customAgentRole.findMany({
    where:   { userId: auth.userId },
    orderBy: [{ insertAfter: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
  return ok(rows)
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { name, icon, description, systemPrompt, provider, model, insertAfter } = body as {
    name?: string; icon?: string; description?: string; systemPrompt?: string
    provider?: string; model?: string; insertAfter?: string
  }

  if (!name?.trim()) return err('name is required')

  const VALID_INSERT_AFTER = ['scout', 'analyst', 'writer', 'reviewer', 'executor', 'auditor']
  const after = insertAfter && VALID_INSERT_AFTER.includes(insertAfter) ? insertAfter : 'auditor'

  const row = await db.customAgentRole.create({
    data: {
      userId:      auth.userId,
      name:        name.trim(),
      icon:        icon?.trim()         || '🧩',
      description: description?.trim()  || null,
      systemPrompt: systemPrompt?.trim() || null,
      provider:    provider             || 'anthropic',
      model:       model                || 'claude-haiku-4-5-20251001',
      insertAfter: after,
      enabled:     true,
    },
  })

  return ok(row)
}
