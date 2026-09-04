import type { Plan, Prisma } from '@prisma/client'

export type BroadcastAudience =
  | { type: 'all_active_users'; value: Record<string, never> }
  | { type: 'plan'; value: { plan: Plan } }
  | { type: 'location'; value: { location: string } }
  | { type: 'explicit_user_ids'; value: { userIds: string[] } }

function plainText(value: unknown, max: number) {
  if (typeof value !== 'string') return null
  const text = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > 0 && text.length <= max ? text : null
}

export function parseBroadcastInput(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const title = plainText(record.title, 120)
  const body = plainText(record.body, 2_000)
  if (!title || !body || typeof record.audienceType !== 'string') return null
  const audience = parseAudience(record.audienceType, record.audience)
  return audience ? { title, body, audience } : null
}

export function parseAudience(type: string, value: unknown): BroadcastAudience | null {
  const audience = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (type === 'all_active_users') return { type, value: {} }
  if (type === 'plan' && (audience.plan === 'free' || audience.plan === 'pro' || audience.plan === 'enterprise')) return { type, value: { plan: audience.plan } }
  if (type === 'location') {
    const location = plainText(audience.location, 80)
    return location ? { type, value: { location } } : null
  }
  if (type === 'explicit_user_ids' && Array.isArray(audience.userIds)) {
    const userIds = [...new Set(audience.userIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64))]
    return userIds.length > 0 && userIds.length <= 1_000 ? { type, value: { userIds } } : null
  }
  return null
}

export function audienceWhere(audience: BroadcastAudience): Prisma.UserWhereInput {
  const active = { accountStatus: 'active' as const }
  if (audience.type === 'plan') return { ...active, plan: audience.value.plan }
  if (audience.type === 'location') return { ...active, location: audience.value.location }
  if (audience.type === 'explicit_user_ids') return { ...active, id: { in: audience.value.userIds } }
  return active
}

export function storedAudience(value: unknown, type: string): BroadcastAudience | null {
  return parseAudience(type, value)
}
