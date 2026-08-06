import type { BroadcastAudienceType, BroadcastStatus, Plan } from '@prisma/client'

export interface BroadcastAudience { audienceType: BroadcastAudienceType; audience: { plan?: Plan; location?: string; userIds?: string[] } }

export function sanitizeBroadcastText(value: unknown, maxLength = 2000): { text: string; redacted: boolean } {
  if (typeof value !== 'string') throw new Error('Broadcast text is required')
  const stripped = value.replace(/<[^>]*>/g, '').trim()
  if (!stripped || stripped.length > maxLength) throw new Error('Broadcast text is invalid')
  const secretPattern = /(sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN[\s\S]+?-----|\b\d{13,19}\b)/gi
  const text = stripped.replace(secretPattern, '[REDACTED]')
  return { text, redacted: text !== stripped }
}

export function validateBroadcastAudience(input: unknown): BroadcastAudience {
  const row = record(input); const audienceType = row.audienceType
  if (audienceType === 'all_active_users') return { audienceType, audience: {} }
  if (audienceType === 'plan') { if (row.plan !== 'free' && row.plan !== 'pro' && row.plan !== 'enterprise') throw new Error('Plan audience is invalid'); return { audienceType, audience: { plan: row.plan } } }
  if (audienceType === 'location') { if (typeof row.location !== 'string' || !row.location.trim() || row.location.trim().length > 100) throw new Error('Location audience is invalid'); return { audienceType, audience: { location: row.location.trim() } } }
  if (audienceType === 'explicit_user_ids') { if (!Array.isArray(row.userIds) || row.userIds.length === 0 || row.userIds.length > 1000 || row.userIds.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Explicit audience is invalid'); return { audienceType, audience: { userIds: [...new Set(row.userIds.map(value => (value as string).trim()))] } } }
  throw new Error('Broadcast audience is invalid')
}

export function validateBroadcastStatus(current: BroadcastStatus | string, next: BroadcastStatus | string): boolean {
  return current === 'draft' && next === 'pending_approval' || current === 'pending_approval' && next === 'draft' || current === 'pending_approval' && next === 'scheduled' || current === 'scheduled' && next === 'publishing' || current === 'publishing' && next === 'published' || ['draft', 'pending_approval', 'scheduled'].includes(current) && next === 'cancelled'
}

export function broadcastWhere(value: BroadcastAudience) {
  if (value.audienceType === 'all_active_users') return { accountStatus: 'active' as const }
  if (value.audienceType === 'plan') return { accountStatus: 'active' as const, plan: value.audience.plan }
  if (value.audienceType === 'location') return { accountStatus: 'active' as const, location: value.audience.location }
  return { accountStatus: 'active' as const, id: { in: value.audience.userIds } }
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
