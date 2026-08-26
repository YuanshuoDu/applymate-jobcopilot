import { pinnedFetch, type PinnedFetchOptions } from '@jobcopilot/shared'
import { db } from '@/lib/db'
import { isJobApiProvider } from './job-api-catalog'

export type ApiCredentialSource = 'platform' | 'user' | 'public'
export type ApiUsageRuntime = 'web' | 'worker' | 'admin' | 'unknown'

export type JobApiRequestMeta = {
  provider: string
  operation: string
  credentialSource: ApiCredentialSource
  runtime?: ApiUsageRuntime
  userId?: string
}

type UsageRecord = JobApiRequestMeta & {
  requestCount?: number
  jobsReturned?: number
  latencyMs: number
  status: 'success' | 'error'
  httpStatus?: number
  rateLimitLimit?: number
  rateLimitRemaining?: number
  rateLimitResetAt?: Date
}

type Dependencies = {
  request?: typeof pinnedFetch
  create?: (input: UsageRecord) => Promise<string | null>
  updateJobs?: (eventId: string, jobsReturned: number) => Promise<void>
}

const eventIds = new WeakMap<Response, string>()

export async function trackedJobApiFetch(
  url: string | URL,
  init: PinnedFetchOptions,
  meta: JobApiRequestMeta,
  dependencies: Dependencies = {},
): Promise<Response> {
  const request = dependencies.request ?? pinnedFetch
  const create = dependencies.create ?? persistUsage
  const startedAt = Date.now()
  try {
    const response = await request(url, init)
    const eventId = await create({
      ...safeMeta(meta),
      latencyMs: Date.now() - startedAt,
      status: response.ok ? 'success' : 'error',
      httpStatus: response.status,
      ...rateLimitMetadata(response.headers),
    })
    if (eventId) eventIds.set(response, eventId)
    return response
  } catch (error) {
    await create({ ...safeMeta(meta), latencyMs: Date.now() - startedAt, status: 'error' })
    throw error
  }
}

export async function reportJobApiJobs(
  response: Response,
  jobsReturned: number,
  dependencies: Dependencies = {},
): Promise<void> {
  const eventId = eventIds.get(response)
  if (!eventId) return
  eventIds.delete(response)
  const update = dependencies.updateJobs ?? persistJobsReturned
  await update(eventId, Math.max(0, Math.trunc(jobsReturned)))
}

function safeMeta(meta: JobApiRequestMeta): JobApiRequestMeta {
  return {
    provider: isJobApiProvider(meta.provider) ? meta.provider : 'unknown',
    operation: safeKey(meta.operation, 'request'),
    credentialSource: meta.credentialSource,
    runtime: meta.runtime ?? 'web',
    userId: meta.userId?.slice(0, 120),
  }
}

function safeKey(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 80)
  return normalized || fallback
}

function positiveInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function resetAt(value: string | null): Date | undefined {
  if (!value) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric < 1_000_000_000
      ? Date.now() + numeric * 1_000
      : numeric > 10_000_000_000 ? numeric : numeric * 1_000
    const parsed = new Date(milliseconds)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function rateLimitMetadata(headers: Headers) {
  return {
    rateLimitLimit: positiveInteger(headers.get('x-ratelimit-limit')),
    rateLimitRemaining: positiveInteger(headers.get('x-ratelimit-remaining')),
    rateLimitResetAt: resetAt(headers.get('x-ratelimit-reset')),
  }
}

async function persistUsage(input: UsageRecord): Promise<string | null> {
  if (process.env.NODE_ENV === 'test' || typeof db.jobApiUsageEvent?.create !== 'function') return null
  return db.jobApiUsageEvent.create({
    data: {
      ...input,
      requestCount: Math.max(0, Math.trunc(input.requestCount ?? 1)),
      jobsReturned: Math.max(0, Math.trunc(input.jobsReturned ?? 0)),
      latencyMs: Math.max(0, Math.trunc(input.latencyMs)),
    },
    select: { id: true },
  }).then(row => row.id).catch(() => null)
}

async function persistJobsReturned(eventId: string, jobsReturned: number): Promise<void> {
  if (process.env.NODE_ENV === 'test' || typeof db.jobApiUsageEvent?.updateMany !== 'function') return
  await db.jobApiUsageEvent.updateMany({
    where: { id: eventId },
    data: { jobsReturned: Math.max(0, Math.trunc(jobsReturned)) },
  }).catch(() => undefined)
}
