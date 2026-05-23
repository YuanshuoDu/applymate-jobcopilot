/**
 * GET   /api/agent  — get agent config for current user
 * PATCH /api/agent  — update agent config
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

const DEFAULTS = {
  isRunning:         false,
  dailyLimit:        10,
  minMatchScore:     75,
  autoApply:         false,
  requireApproval:   true,
  targetLocations:   [] as string[],
  targetRoles:       [] as string[],
  excludeCompanies:  [] as string[],
  priorityCompanies: [] as string[],
  autoCoverLetter:   false,
  coverTone:         'professional',
  useTailoredCV:     false,
  salaryMin:         0,
  salaryMax:         0,
  notifyApply:       true,
  notifyReject:      true,
  weeklySummary:     false,
  followUpReminder:  true,
  followUpDays:      7,
  model:             'claude-sonnet-4-6',
}

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const config = await db.agentConfig.findUnique({ where: { userId: auth.userId } })

  return ok(config ?? DEFAULTS)
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const allowedFields = [
    'isRunning', 'dailyLimit', 'minMatchScore', 'autoApply',
    'requireApproval', 'targetLocations', 'targetRoles', 'excludeCompanies',
    'priorityCompanies', 'autoCoverLetter', 'coverTone', 'useTailoredCV',
    'salaryMin', 'salaryMax', 'notifyApply', 'notifyReject',
    'weeklySummary', 'followUpReminder', 'followUpDays', 'model',
  ]
  const data: Record<string, unknown> = {}
  for (const field of allowedFields) {
    if (field in body) data[field] = body[field]
  }

  const config = await db.agentConfig.upsert({
    where:  { userId: auth.userId },
    update: data as any,
    create: { userId: auth.userId, ...DEFAULTS, ...data } as any,
  })

  return ok(config)
}
