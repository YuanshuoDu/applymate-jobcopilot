/**
 * GET /api/jsearch/search
 * Params: q, location, country (us/gb/de/...), page, employment_type, remote
 * Proxies JSearch v2 (RapidAPI) — aggregates Google for Jobs, Indeed, LinkedIn etc.
 * Requires RAPIDAPI_KEY in environment.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { getDiscoveryApiKeys } from '@/lib/discovery-api-keys'
import { truncate, fmtSalary } from '@/lib/utils'

const HOST = 'jsearch.p.rapidapi.com'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { rapidapiKey: apiKey } = await getDiscoveryApiKeys(auth.userId)
  if (!apiKey) return err('RapidAPI is not configured. Add a key in Settings → Keys & connections.', 501)

  const { searchParams } = req.nextUrl
  const q              = searchParams.get('q')?.trim()
  const location       = searchParams.get('location')?.trim() ?? ''
  const country        = searchParams.get('country')?.trim() ?? 'us'
  const page           = parseInt(searchParams.get('page') ?? '1', 10)
  const employmentType = searchParams.get('employment_type') ?? ''
  const remoteOnly     = searchParams.get('remote') === '1'

  if (!q) return err('q is required')

  const query = location ? `${q} in ${location}` : q
  const params = new URLSearchParams({ query, num_pages: '1', country, date_posted: 'all', page: String(page) })
  if (employmentType) params.set('employment_types', employmentType)
  if (remoteOnly)     params.set('remote_jobs_only', 'true')

  let raw: Response
  try {
    raw = await fetch(`https://${HOST}/search-v2?${params}`, {
      headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': HOST },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach JSearch API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`JSearch error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as {
    status: string
    data: {
      jobs: Array<{
        job_id:                      string
        job_title:                   string
        employer_name:               string
        employer_logo?:              string
        job_city?:                   string
        job_state?:                  string
        job_country?:                string
        job_employment_type?:        string
        job_apply_link:              string
        job_description?:            string
        job_posted_at_datetime_utc?: string
        job_min_salary?:             number | null
        job_max_salary?:             number | null
        job_salary_currency?:        string | null
        job_is_remote?:              boolean
      }>
      total_count?: number
    }
  }

  const jobs = (json.data?.jobs ?? []).map(r => {
    const loc = [r.job_city, r.job_state, r.job_country].filter(Boolean).join(', ')
    return {
      id:          r.job_id,
      title:       r.job_title,
      company:     r.employer_name ?? '',
      location:    r.job_is_remote ? `Remote${loc ? ` · ${loc}` : ''}` : (loc || 'Unknown'),
      salary:      fmtSalary(r.job_min_salary, r.job_max_salary, r.job_salary_currency ?? 'USD'),
      description: truncate(r.job_description ?? ''),
      url:         r.job_apply_link,
      postedAt:    r.job_posted_at_datetime_utc ?? null,
      jobType:     r.job_employment_type ?? null,
      source:      'jsearch' as const,
    }
  })

  return ok({ jobs, total: json.data?.total_count ?? jobs.length * 5, page })
}
