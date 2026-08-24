import type { Pool } from 'pg'
import {
  acquireAtsPacing,
  canUseAtsSource,
  loadEffectiveAtsPolicy,
  type AtsPolicyRedis,
  withAtsRetries,
} from '../admin/ats-policy.js'
import { recordWorkerJobApiUsage } from '../api-usage/job-api-usage.js'

export interface DiscoveredJob {
  title: string
  company: string
  location: string
  url: string
  description: string
  salary: string | null
  logo: string | null
  source: string
}

type DiscoveryInput = {
  pool: Pick<Pool, 'query'>
  redis: AtsPolicyRedis
  request?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  userId: string
  slugs: string[]
}

type GreenhouseJob = { id: number; title: string; absolute_url: string; location: { name: string }; content?: string }
type LeverPosting = { text: string; hostedUrl: string; descriptionPlain?: string; description?: string; categories?: { location?: string } }

export async function discoverGreenhouseJobs(input: DiscoveryInput): Promise<DiscoveredJob[]> {
  const jobs = await discover(input, 'greenhouse', slug => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`)
  return jobs.flatMap(({ slug, payload }) => {
    const response = payload as { jobs?: GreenhouseJob[] }
    return (response.jobs ?? []).map(job => ({
      title: job.title,
      company: slug,
      location: job.location?.name ?? '',
      url: job.absolute_url,
      description: job.content ? stripHtml(job.content) : '',
      salary: null,
      logo: null,
      source: 'greenhouse',
    }))
  })
}

export async function discoverLeverJobs(input: DiscoveryInput): Promise<DiscoveredJob[]> {
  const jobs = await discover(input, 'lever', slug => `https://api.lever.co/v0/postings/${slug}?mode=json`)
  return jobs.flatMap(({ slug, payload }) => (payload as LeverPosting[]).map(posting => ({
    title: posting.text,
    company: slug,
    location: posting.categories?.location ?? '',
    url: posting.hostedUrl,
    description: posting.descriptionPlain ?? (posting.description ? stripHtml(posting.description) : ''),
    salary: null,
    logo: null,
    source: 'lever',
  })))
}

async function discover(input: DiscoveryInput, sourceKey: 'greenhouse' | 'lever', urlFor: (slug: string) => string) {
  const request = input.request ?? fetch
  const sleep = input.sleep ?? wait
  try {
    const policy = await loadEffectiveAtsPolicy(input.pool, sourceKey)
    if (!canUseAtsSource(policy, input.userId, 'discovery')) return []
  } catch (error) {
    logPolicyFailure(sourceKey, error)
    return []
  }

  const results: Array<{ slug: string; payload: unknown }> = []
  for (const slug of input.slugs) {
    const payload = await requestJson(input, sourceKey, request, sleep, urlFor(slug))
    if (payload !== null) results.push({ slug, payload })
  }
  return results
}

async function requestJson(
  input: DiscoveryInput,
  sourceKey: 'greenhouse' | 'lever',
  request: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
  url: string,
): Promise<unknown | null> {
  let policy
  try {
    policy = await loadEffectiveAtsPolicy(input.pool, sourceKey)
    if (!canUseAtsSource(policy, input.userId, 'discovery')) return null
    return await withAtsRetries(policy, async () => {
      const current = await loadEffectiveAtsPolicy(input.pool, sourceKey)
      if (!canUseAtsSource(current, input.userId, 'discovery')) throw new PolicyBlockedError()
      await acquireAtsPacing(input.redis, current, input.userId, sleep)
      const startedAt = Date.now()
      let result: Response
      try {
        result = await request(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) })
      } catch (error) {
        await recordWorkerJobApiUsage({ pool: input.pool, userId: input.userId, provider: sourceKey, latencyMs: Date.now() - startedAt, status: 'error' })
        throw error
      }
      if (!result.ok) {
        await recordWorkerJobApiUsage({ pool: input.pool, userId: input.userId, provider: sourceKey, latencyMs: Date.now() - startedAt, status: 'error', httpStatus: result.status })
        if (result.status === 429 || result.status >= 500) throw new RetryableResponseError(result.status)
        return null
      }
      let payload: unknown
      try {
        payload = await result.json()
      } catch (error) {
        await recordWorkerJobApiUsage({ pool: input.pool, userId: input.userId, provider: sourceKey, latencyMs: Date.now() - startedAt, status: 'error', httpStatus: result.status })
        throw error
      }
      await recordWorkerJobApiUsage({ pool: input.pool, userId: input.userId, provider: sourceKey, latencyMs: Date.now() - startedAt, status: 'success', httpStatus: result.status, jobsReturned: returnedJobCount(sourceKey, payload) })
      return payload
    }, sleep, error => !(error instanceof PolicyBlockedError))
  } catch (error) {
    if (!(error instanceof PolicyBlockedError)) logPolicyFailure(sourceKey, error)
    return null
  }
}

function returnedJobCount(sourceKey: 'greenhouse' | 'lever', payload: unknown): number {
  if (sourceKey === 'lever') return Array.isArray(payload) ? payload.length : 0
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 0
  return Array.isArray((payload as { jobs?: unknown }).jobs) ? (payload as { jobs: unknown[] }).jobs.length : 0
}

class PolicyBlockedError extends Error {}
class RetryableResponseError extends Error {
  constructor(status: number) {
    super(`Provider returned retryable HTTP status ${status}`)
    this.name = 'RetryableResponseError'
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, '').replace(/\s+/g, ' ').trim()
}

function logPolicyFailure(sourceKey: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.warn('[scout-worker] ATS request skipped', { sourceKey, error: message })
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
