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

const BOOLEAN_FIELDS = [
  'isRunning', 'autoApply', 'requireApproval', 'autoCoverLetter',
  'useTailoredCV', 'notifyApply', 'notifyReject', 'weeklySummary',
  'followUpReminder',
] as const

const INTEGER_FIELDS = [
  'dailyLimit', 'minMatchScore', 'salaryMin', 'salaryMax', 'followUpDays',
] as const

const STRING_ARRAY_FIELDS = [
  'targetLocations', 'targetRoles', 'excludeCompanies', 'priorityCompanies',
] as const

const STRING_FIELDS = ['coverTone', 'model'] as const

type BooleanField = typeof BOOLEAN_FIELDS[number]
type IntegerField = typeof INTEGER_FIELDS[number]
type StringArrayField = typeof STRING_ARRAY_FIELDS[number]
type StringField = typeof STRING_FIELDS[number]
type AgentConfigPatch =
  Partial<Record<BooleanField, boolean>>
  & Partial<Record<IntegerField, number>>
  & Partial<Record<StringArrayField, string[]>>
  & Partial<Record<StringField, string>>

function readAgentConfigPatch(body: unknown): { data: AgentConfigPatch } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Invalid JSON body' }
  const row = body as Record<string, unknown>
  const data: AgentConfigPatch = {}

  for (const field of BOOLEAN_FIELDS) {
    if (!(field in row)) continue
    if (typeof row[field] !== 'boolean') return { error: `${field} must be a boolean` }
    data[field] = row[field]
  }
  for (const field of INTEGER_FIELDS) {
    if (!(field in row)) continue
    if (!Number.isInteger(row[field])) return { error: `${field} must be an integer` }
    data[field] = row[field] as number
  }
  for (const field of STRING_ARRAY_FIELDS) {
    if (!(field in row)) continue
    if (!Array.isArray(row[field]) || !row[field].every(item => typeof item === 'string')) {
      return { error: `${field} must be a string array` }
    }
    data[field] = row[field] as string[]
  }
  for (const field of STRING_FIELDS) {
    if (!(field in row)) continue
    if (typeof row[field] !== 'string') return { error: `${field} must be a string` }
    data[field] = row[field]
  }

  return { data }
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
  const parsed = readAgentConfigPatch(body)
  if ('error' in parsed) return err(parsed.error)

  const config = await db.agentConfig.upsert({
    where:  { userId: auth.userId },
    update: parsed.data,
    create: { userId: auth.userId, ...DEFAULTS, ...parsed.data },
  })

  return ok(config)
}
