import { db } from '@/lib/db'

export type DiscoveryOptimizationInput = {
  userId?: string
  eventType: 'cache_hit' | 'singleflight_hit' | 'provider_skipped' | 'provider_selected' | 'shadow_comparison'
  provider?: string
  credentialScope: 'platform' | 'user' | 'public'
  requestsAvoided?: number
  jobsReturned?: number
  netNewJobs?: number
  validApplyUrls?: number
  completeDescriptions?: number
  latencyMs?: number
  reasonCode?: string
  metadata?: Record<string, string | number | boolean | null>
}

function boundedInt(value: number | undefined): number {
  return Math.max(0, Math.trunc(value ?? 0))
}

function safeCode(value: string | undefined): string | undefined {
  if (!value) return undefined
  const code = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 80)
  return code || undefined
}

export async function recordDiscoveryOptimization(input: DiscoveryOptimizationInput): Promise<void> {
  if (process.env.NODE_ENV === 'test') return
  const delegate = (db as unknown as {
    discoveryOptimizationEvent?: { create(args: { data: Record<string, unknown> }): Promise<unknown> }
  }).discoveryOptimizationEvent
  if (!delegate) return
  await delegate.create({
    data: {
      userId: input.userId,
      eventType: input.eventType,
      provider: input.provider,
      credentialScope: input.credentialScope,
      requestsAvoided: boundedInt(input.requestsAvoided),
      jobsReturned: boundedInt(input.jobsReturned),
      netNewJobs: boundedInt(input.netNewJobs),
      validApplyUrls: boundedInt(input.validApplyUrls),
      completeDescriptions: boundedInt(input.completeDescriptions),
      latencyMs: boundedInt(input.latencyMs),
      reasonCode: safeCode(input.reasonCode),
      metadata: input.metadata,
    },
  }).catch(() => undefined)
}
