import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { quotaPeriodBounds, type QuotaPeriod } from '@/lib/api-usage/quota-period'
import type { DiscoveryProviderState, QuotaBand } from './provider-router'

const RESERVE_RATIO = 0.15
const RESERVATION_TTL_MS = 30_000
const HEALTH_WINDOW_MS = 15 * 60_000
const CIRCUIT_COOLDOWN_MS = 5 * 60_000

type QuotaRow = {
  id: string
  provider: string
  operation: string
  metric: string
  period: string
  resetDay: number
  limit: number
  enabled: boolean
}

type ReservationRow = { id: string; metric: string }

export type ProviderQuotaInput = {
  provider: string
  operation: string
  credentialSource: 'platform' | 'user' | 'public'
  expectedJobs: number
  priority?: 'interactive' | 'agent'
}

export type ProviderQuotaReservation = {
  settle(jobsReturned: number, success: boolean): Promise<void>
}

export type ProviderHealthEvent = {
  status: string
  httpStatus: number | null
  rateLimitLimit: number | null
  rateLimitRemaining: number | null
  createdAt: Date
}

export function quotaBand(used: number, limit: number): QuotaBand {
  if (limit <= 0 || used >= limit) return 'exhausted'
  const remaining = (limit - used) / limit
  if (remaining <= 0.1) return 'red'
  if (remaining <= 0.3) return 'amber'
  return 'green'
}

export function circuitIsOpen(events: readonly ProviderHealthEvent[], now = new Date()): boolean {
  const recent = events.filter(event => now.getTime() - event.createdAt.getTime() <= HEALTH_WINDOW_MS)
  if (recent.length === 0) return false
  const latest = [...recent].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  const latestFailure = latest.status === 'error' && (latest.httpStatus === 429 || latest.httpStatus === null || latest.httpStatus >= 500)
  const errors = recent.filter(event => event.status === 'error').length
  return (latestFailure && now.getTime() - latest.createdAt.getTime() < CIRCUIT_COOLDOWN_MS)
    || (recent.length >= 3 && errors / recent.length >= 0.6)
}

function matchingQuota(quota: QuotaRow, operation: string): boolean {
  return quota.enabled && (quota.operation === '*' || quota.operation === operation)
}

function unitsFor(metric: string, expectedJobs: number): number {
  return metric === 'jobs' ? Math.max(1, Math.trunc(expectedJobs)) : 1
}

function reserveFloor(quota: QuotaRow, priority: ProviderQuotaInput['priority']): number {
  return priority === 'agent' ? 0 : quota.limit * RESERVE_RATIO
}

function isMissingTable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2021'
}

function noOpReservation(): ProviderQuotaReservation {
  return { settle: async () => undefined }
}

async function withSerializableRetry<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      const retryable = typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034'
      if (!retryable || attempt === 2) throw error
    }
  }
  throw new Error('serializable_retry_exhausted')
}

export async function reserveProviderQuota(input: ProviderQuotaInput): Promise<ProviderQuotaReservation | null> {
  if (input.credentialSource !== 'platform') return noOpReservation()
  if (process.env.NODE_ENV === 'test') return noOpReservation()

  try {
    const created = await withSerializableRetry(() => db.$transaction(async tx => {
      const quotas = await tx.apiQuota.findMany({
        where: { category: 'job', provider: input.provider, enabled: true, OR: [{ operation: input.operation }, { operation: '*' }] },
        orderBy: { operation: 'asc' },
      }) as QuotaRow[]
      if (quotas.length === 0) return [] as ReservationRow[]

      const now = new Date()
      const rows: ReservationRow[] = []
      for (const quota of quotas.filter(row => matchingQuota(row, input.operation))) {
        const bounds = quotaPeriodBounds(quota.period as QuotaPeriod, quota.resetDay, now)
        const usage = await tx.jobApiUsageEvent.aggregate({
          where: { provider: input.provider, operation: quota.operation === '*' ? undefined : quota.operation, credentialSource: 'platform', createdAt: { gte: bounds.start, lt: bounds.end } },
          _sum: { jobsReturned: true, requestCount: true },
        })
        const used = quota.metric === 'jobs'
          ? Number(usage._sum.jobsReturned ?? 0)
          : Number(usage._sum.requestCount ?? 0)
        const reserved = await tx.apiQuotaReservation.aggregate({
          where: { quotaId: quota.id, periodStart: bounds.start, periodEnd: bounds.end, status: 'reserved', expiresAt: { gt: now } },
          _sum: { requestedUnits: true },
        })
        const requested = unitsFor(quota.metric, input.expectedJobs)
        const available = quota.limit - reserveFloor(quota, input.priority) - used - Number(reserved._sum.requestedUnits ?? 0)
        if (available < requested) return null
        const reservation = await tx.apiQuotaReservation.create({
          data: {
            quotaId: quota.id, provider: input.provider, operation: input.operation, metric: quota.metric,
            credentialScope: 'platform', periodStart: bounds.start, periodEnd: bounds.end,
            requestedUnits: requested, expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
          },
          select: { id: true, metric: true },
        })
        rows.push(reservation)
      }
      return rows
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }))

    if (created === null) return null
    if (created.length === 0) return noOpReservation()
    return {
      settle: async (jobsReturned, success) => {
        await Promise.all(created.map(row => db.apiQuotaReservation.updateMany({
          where: { id: row.id, status: 'reserved' },
          data: { status: success || row.metric === 'requests' ? 'settled' : 'released', settledUnits: row.metric === 'jobs' ? Math.max(0, Math.trunc(jobsReturned)) : 1 },
        }).catch(() => undefined)))
      },
    }
  } catch (error) {
    if (!isMissingTable(error)) console.warn('[discovery-quota] reservation failed open', error instanceof Error ? error.message : 'unknown')
    return noOpReservation()
  }
}

function latestRateRatio(events: readonly ProviderHealthEvent[]): number | null {
  const latest = [...events].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).find(event => event.rateLimitLimit && event.rateLimitRemaining !== null)
  if (!latest || !latest.rateLimitLimit || latest.rateLimitRemaining === null) return null
  return Math.max(0, Math.min(1, latest.rateLimitRemaining / latest.rateLimitLimit))
}

export async function loadProviderStates(providers: readonly string[], credentialSource: 'platform' | 'user' | 'public' = 'platform'): Promise<Map<string, DiscoveryProviderState>> {
  const states = new Map<string, DiscoveryProviderState>()
  for (const provider of providers) states.set(provider, { quotaBand: 'green', circuitOpen: false, recentErrorRate: 0, remainingRatio: null })
  if (process.env.NODE_ENV === 'test' || providers.length === 0) return states

  try {
    const since = new Date(Date.now() - HEALTH_WINDOW_MS)
    const [quotas, events] = await Promise.all([
      db.apiQuota.findMany({ where: { category: 'job', enabled: true, provider: { in: [...providers] } } }) as Promise<QuotaRow[]>,
      db.jobApiUsageEvent.findMany({ where: { provider: { in: [...providers] }, credentialSource, createdAt: { gte: since } }, select: { provider: true, status: true, httpStatus: true, rateLimitLimit: true, rateLimitRemaining: true, createdAt: true } }),
    ])
    for (const provider of providers) {
      const providerEvents = events.filter(event => event.provider === provider) as ProviderHealthEvent[]
      const providerQuotas = quotas.filter(quota => quota.provider === provider)
      const usedByQuota = await Promise.all(providerQuotas.map(async quota => {
        const bounds = quotaPeriodBounds(quota.period as QuotaPeriod, quota.resetDay)
        const aggregate = await db.jobApiUsageEvent.aggregate({
          where: { provider, operation: quota.operation === '*' ? undefined : quota.operation, credentialSource, createdAt: { gte: bounds.start, lt: bounds.end } },
          _sum: { jobsReturned: true, requestCount: true },
        })
        return { quota, used: quota.metric === 'jobs' ? Number(aggregate._sum.jobsReturned ?? 0) : Number(aggregate._sum.requestCount ?? 0) }
      }))
      const mostUsed = usedByQuota.sort((a, b) => (a.used / Math.max(a.quota.limit, 1)) - (b.used / Math.max(b.quota.limit, 1))).at(-1)
      const errorCount = providerEvents.filter(event => event.status === 'error').length
      states.set(provider, {
        quotaBand: mostUsed ? quotaBand(mostUsed.used, mostUsed.quota.limit) : 'green',
        circuitOpen: circuitIsOpen(providerEvents),
        recentErrorRate: providerEvents.length ? errorCount / providerEvents.length : 0,
        remainingRatio: latestRateRatio(providerEvents),
      })
    }
  } catch (error) {
    if (!isMissingTable(error)) console.warn('[discovery-quota] state read failed; using green defaults', error instanceof Error ? error.message : 'unknown')
  }
  return states
}
