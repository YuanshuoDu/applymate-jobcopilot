/**
 * GET /api/adzuna/search
 * Query params: q, where, country (gb/ie/de/fr/nl/es/it/at/be/pl/us/ca/au), page, job_type
 * Proxies Adzuna job search API. Uses candidate credentials first, then the platform pair.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { DISCOVERY_KEY_ERROR_MESSAGES, getDiscoveryApiAccess } from '@/lib/discovery-api-keys'
import { truncate, fmtSalary as fmtSal } from '@/lib/utils'
import { reportJobApiJobs, trackedJobApiFetch } from '@/lib/api-usage/job-api-usage'

const ADZUNA_BASE = 'https://api.adzuna.com/v1/api/jobs'

function fmtSalary(min?: number, max?: number, country = 'gb', predicted = false): string | undefined {
  const base = fmtSal(min, max, country)
  if (!base) return undefined
  return predicted ? `~${base}` : base
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'job_discovery')
  if (isErrorResponse(auth)) return auth

  const { adzunaAppId: appId, adzunaAppKey: appKey, adzunaSource } = await getDiscoveryApiAccess(auth.userId)
  if (!appId || !appKey) {
    return err(DISCOVERY_KEY_ERROR_MESSAGES.adzuna, 501)
  }

  const { searchParams } = req.nextUrl
  const q        = searchParams.get('q')?.trim()
  const where    = searchParams.get('where')?.trim() ?? ''
  const country  = (searchParams.get('country') ?? 'gb').toLowerCase()
  const page     = parseInt(searchParams.get('page') ?? '1', 10)
  const jobType  = searchParams.get('job_type') ?? ''

  if (!q) return err('q (keywords) is required')

  const params = new URLSearchParams({
    app_id:          appId,
    app_key:         appKey,
    results_per_page: '20',
    sort_by:         'date',
    what:            q,
  })
  if (where)   params.set('where', where)
  if (jobType === 'fulltime')   params.set('full_time', '1')
  if (jobType === 'parttime')   params.set('part_time', '1')
  if (jobType === 'contract')   params.set('contract',  '1')
  if (jobType === 'permanent')  params.set('permanent', '1')

  const url = `${ADZUNA_BASE}/${country}/search/${page}?${params}`

  let raw: Response
  try {
    raw = await trackedJobApiFetch(url, { cache: 'no-store', redirect: 'error' }, {
      provider: 'adzuna', operation: 'search', credentialSource: adzunaSource === 'user' ? 'user' : 'platform', userId: auth.userId,
    })
  } catch {
    return err('Failed to reach Adzuna API', 502)
  }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Adzuna error ${raw.status}: ${msg}`, 502)
  }

  const json = await raw.json() as {
    results: Array<{
      id:                  string
      title:               string
      company:             { display_name: string }
      location:            { display_name: string }
      salary_min?:         number
      salary_max?:         number
      salary_is_predicted?: string
      redirect_url:        string
      description:         string
      created:             string
      contract_time?:      string
      contract_type?:      string
    }>
    count: number
  }
  await reportJobApiJobs(raw, json.results?.length ?? 0)

  const jobs = (json.results ?? []).map(r => ({
    id:             r.id,
    title:          r.title,
    company:        r.company?.display_name ?? '',
    location:       r.location?.display_name ?? '',
    salary:         fmtSalary(r.salary_min, r.salary_max, country, r.salary_is_predicted === '1'),
    description:    truncate(r.description ?? ''),
    url:            r.redirect_url,
    postedAt:       r.created,
    contractTime:   r.contract_time ?? null,
    contractType:   r.contract_type ?? null,
  }))

  return ok({ jobs, total: json.count ?? 0, page })
}
