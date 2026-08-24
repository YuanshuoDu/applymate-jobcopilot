import type { DiscoveredJob } from '../discover'
import { acquire } from '../pace/policies'
import { reportJobApiJobs, trackedJobApiFetch } from '@/lib/api-usage/job-api-usage'

const BASE_URL = 'https://data.fantastic.jobs/v1/active-ats'

export interface FantasticJobsQuery {
  apiKey: string
  userId?: string
  title?: string
  location?: string
  datePosted?: string
}

export interface FantasticJob extends DiscoveredJob {
  externalId: string
  postedAt: string | null
  jobType: string | null
  experienceLevel: string | null
  workArrangement: string | null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function location(job: Record<string, unknown>): string {
  const values = [job.locations_derived, job.locations_alt]
    .flatMap(value => Array.isArray(value) ? value.map(text) : [])
    .filter(Boolean)
  return [...new Set(values)].join(' · ')
}

function salary(job: Record<string, unknown>): string | null {
  const min = number(job.ai_salary_min)
  const max = number(job.ai_salary_max)
  if (min === null && max === null) return null
  const currency = text(job.ai_salary_currency)
  const unit = text(job.ai_salary_unit)
  const range = min !== null && max !== null && min !== max
    ? `${min.toLocaleString()}–${max.toLocaleString()}`
    : (min ?? max)!.toLocaleString()
  return `${currency ? `${currency} ` : ''}${range}${unit ? ` / ${unit}` : ''}`
}

function mapJob(value: unknown): FantasticJob | null {
  const job = record(value)
  const organization = record(job.organization)
  const title = text(job.title)
  const company = text(organization.name) || text(job.organization) || text(job.company)
  const url = text(job.url)
  if (!title || !company || !url) return null
  const id = text(job.id) || url
  const arrangement = text(job.ai_work_arrangement)
  return {
    externalId: id,
    title,
    company,
    location: location(job),
    url,
    description: text(job.description_text),
    salary: salary(job),
    logo: text(job.org_logo_permalink) || text(organization.logo) || null,
    source: 'fantasticjobs',
    postedAt: text(job.date_posted) || null,
    jobType: text(job.ai_employment_type) || null,
    experienceLevel: text(job.ai_experience_level) || null,
    workArrangement: arrangement || null,
  }
}

function timeFrame(datePosted?: string): string {
  if (datePosted === 'today') return '24h'
  if (datePosted === 'week') return '7d'
  return '6m'
}

export async function fetchFantasticJobs(query: FantasticJobsQuery): Promise<FantasticJob[]> {
  const apiKey = query.apiKey.trim()
  if (!apiKey) return []
  const params = new URLSearchParams({ time_frame: timeFrame(query.datePosted), limit: '20', description_format: 'text' })
  if (query.title?.trim()) params.set('title', query.title.trim())
  if (query.location?.trim()) params.set('location', query.location.trim())

  await acquire({ ats: 'fantasticjobs' })
  try {
    const response = await trackedJobApiFetch(`${BASE_URL}?${params}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
      redirect: 'error',
    }, {
      provider: 'fantasticjobs', operation: 'list', credentialSource: 'platform', userId: query.userId,
    })
    if (!response.ok) return []
    const payload = await response.json()
    const values: unknown[] = Array.isArray(payload)
      ? payload
      : Array.isArray(record(payload).data) ? record(payload).data as unknown[] : []
    await reportJobApiJobs(response, values.length)
    return values.map(mapJob).filter((job): job is FantasticJob => Boolean(job))
  } catch {
    return []
  }
}
