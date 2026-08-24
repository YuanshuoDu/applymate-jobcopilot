import type { DiscoveredJob } from '../discover'
import { acquire } from '../pace/policies'
import { stripHtml } from '../strip-html'
import { reportJobApiJobs, trackedJobApiFetch } from '@/lib/api-usage/job-api-usage'

const BASE_URL = 'https://api.cleanjobdata.com/jobs'
const MAX_PAGES = 3
const MAX_RESULTS = 60
const PAGE_SIZE = 20

export interface CleanJobDataQuery {
  apiKey: string
  userId?: string
  title: string
  countryCode?: string
  companyName?: string
  remote?: boolean
  datePosted?: string
  experience?: string
  jobType?: string
  salaryMin?: number
  salaryMax?: number
  maxPages?: number
  maxResults?: number
}

export interface CleanJobDataJob extends DiscoveredJob {
  externalId: string
  postedAt: string | null
  jobType: string | null
  experienceLevel: string | null
  workArrangement: string | null
  directApply: true
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function validUrl(value: unknown): string {
  const candidate = asString(value)
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' || url.protocol === 'http:' ? candidate : ''
  } catch {
    return ''
  }
}

function displayLocation(job: Record<string, unknown>): string {
  const raw = asString(job.location)
  const locations = Array.isArray(job.locations) ? job.locations.map(asRecord) : []
  const primary = locations.find(location => location.is_primary === true) ?? locations[0]
  const resolved = asString(primary?.display_label)
  const base = resolved || raw
  const remoteType = asString(job.remote_type)
  return remoteType === 'fully_remote' && !/remote/i.test(base)
    ? `Remote${base ? ` · ${base}` : ''}`
    : base
}

function displaySalary(job: Record<string, unknown>): string | null {
  const salaryText = asString(job.salary_text)
  if (salaryText) return salaryText
  const min = asNumber(job.salary_min)
  const max = asNumber(job.salary_max)
  if (min === null && max === null) return null
  const currency = asString(job.salary_currency)
  const range = min !== null && max !== null && max !== min
    ? `${min.toLocaleString()}–${max.toLocaleString()}`
    : (min ?? max)!.toLocaleString()
  return `${currency ? `${currency} ` : ''}${range}`
}

function workArrangement(remoteType: string): string | null {
  if (remoteType === 'fully_remote') return 'Remote Solely'
  if (remoteType === 'remote_country' || remoteType === 'remote_region' || remoteType === 'hybrid') return 'Remote OK'
  return null
}

function mapJob(value: unknown): CleanJobDataJob | null {
  const job = asRecord(value)
  const company = asRecord(job.company)
  const title = asString(job.title)
  const companyName = asString(company.name)
  const url = validUrl(job.application_url)
  if (!title || !companyName || !url) return null

  const id = typeof job.id === 'number' ? String(job.id) : asString(job.id)
  const remoteType = asString(job.remote_type)
  return {
    title,
    company: companyName,
    location: displayLocation(job),
    url,
    description: stripHtml(asString(job.description)),
    salary: displaySalary(job),
    logo: validUrl(company.logo) || null,
    source: 'cleanjobdata',
    externalId: id || url,
    postedAt: asString(job.published) || null,
    jobType: asString(job.employment_type) || null,
    experienceLevel: asString(job.experience_level) || null,
    workArrangement: workArrangement(remoteType),
    directApply: true,
  }
}

function applyFilters(params: URLSearchParams, query: CleanJobDataQuery): void {
  params.set('extra_fields', 'description')
  params.set('limit', String(PAGE_SIZE))
  if (query.title.trim()) {
    params.set('title', query.title.trim())
    params.set('sort_by', 'relevance')
  }
  if (query.companyName?.trim()) params.set('company_name', query.companyName.trim())
  if (/^[a-z]{2}$/i.test(query.countryCode ?? '')) params.set('location', query.countryCode!.toUpperCase())
  if (query.remote) params.set('remote', 'true')

  const freshness: Record<string, string> = { today: '24h', week: '7d', month: '30d' }
  if (freshness[query.datePosted ?? '']) params.set('max_age', freshness[query.datePosted!])
  const experience: Record<string, string> = { entry: 'EN', mid: 'MI', senior: 'SE', lead: 'EX' }
  if (experience[query.experience ?? '']) params.set('experience_level', experience[query.experience!])
  const jobType: Record<string, string> = {
    fulltime: 'FULL_TIME', parttime: 'PART_TIME', contract: 'CONTRACT', internship: 'INTERN',
  }
  if (jobType[query.jobType ?? '']) params.set('employment_type', jobType[query.jobType!])
  if (query.salaryMin) {
    params.set('salary', query.salaryMax
      ? `${Math.round(query.salaryMin)},${Math.round(query.salaryMax)}`
      : String(Math.round(query.salaryMin)))
  }
}

export async function fetchCleanJobData(query: CleanJobDataQuery): Promise<CleanJobDataJob[]> {
  const apiKey = query.apiKey.trim()
  if (!apiKey) return []

  const pageLimit = Math.min(Math.max(query.maxPages ?? 1, 1), MAX_PAGES)
  const resultLimit = Math.min(Math.max(query.maxResults ?? PAGE_SIZE, 1), MAX_RESULTS)
  const results: CleanJobDataJob[] = []
  let cursor = ''

  for (let page = 0; page < pageLimit && results.length < resultLimit; page += 1) {
    const params = new URLSearchParams()
    applyFilters(params, query)
    if (cursor) params.set('cursor', cursor)

    await acquire({ ats: 'cleanjobdata' })
    try {
      const response = await trackedJobApiFetch(`${BASE_URL}?${params}`, {
        headers: { Accept: 'application/json', 'x-api-key': apiKey },
        signal: AbortSignal.timeout(5_000),
        cache: 'no-store',
        redirect: 'error',
      }, {
        provider: 'cleanjobdata', operation: 'list', credentialSource: 'platform', userId: query.userId,
      })
      if (!response.ok) return page === 0 ? [] : results

      const envelope = asRecord(await response.json())
      await reportJobApiJobs(response, Array.isArray(envelope.data) ? envelope.data.length : 0)
      if (!Array.isArray(envelope.data)) return page === 0 ? [] : results
      for (const value of envelope.data) {
        const job = mapJob(value)
        if (job) results.push(job)
        if (results.length >= resultLimit) break
      }
      cursor = asString(asRecord(envelope.pagination).next_page)
      if (!cursor) break
    } catch {
      return page === 0 ? [] : results
    }
  }

  return results
}
