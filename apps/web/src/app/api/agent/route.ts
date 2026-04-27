/**
 * GET   /api/agent  — get agent config for current user
 * PATCH /api/agent  — update agent config
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const config = await db.agentConfig.findUnique({ where: { userId: auth.userId } })

  // Return defaults if no config yet
  if (!config) {
    return ok({
      isRunning: false,
      dailyLimit: 10,
      minMatchScore: 75,
      autoApply: false,
      requireApproval: true,
      targetLocations: [],
      targetRoles: [],
      excludeCompanies: [],
      model: 'claude-3-5-sonnet',
    })
  }

  return ok(config)
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const allowedFields = [
    'isRunning', 'dailyLimit', 'minMatchScore', 'autoApply',
    'requireApproval', 'targetLocations', 'targetRoles', 'excludeCompanies', 'model',
  ]
  const data: Record<string, unknown> = {}
  for (const field of allowedFields) {
    if (field in body) data[field] = body[field]
  }

  const config = await db.agentConfig.upsert({
    where:  { userId: auth.userId },
    update: data,
    create: {
      userId: auth.userId,
      isRunning:       data.isRunning       as boolean  ?? false,
      dailyLimit:      data.dailyLimit      as number   ?? 10,
      minMatchScore:   data.minMatchScore   as number   ?? 75,
      autoApply:       data.autoApply       as boolean  ?? false,
      requireApproval: data.requireApproval as boolean  ?? true,
      targetLocations: data.targetLocations as string[] ?? [],
      targetRoles:     data.targetRoles     as string[] ?? [],
      excludeCompanies:data.excludeCompanies as string[]?? [],
      model:           data.model           as string   ?? 'claude-3-5-sonnet',
    },
  })

  return ok(config)
}
