/**
 * GET /api/adzuna/search
 * Query params: q, where, country (gb/ie/de/fr/nl/es/it/at/be/pl/us/ca/au), page, job_type
 * Proxies Adzuna job search API. Requires ADZUNA_APP_ID + ADZUNA_APP_KEY in environment.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { getDiscoveryApiKeys } from '@/lib/discovery-api-keys'
import { truncate, fmtSalary as fmtSal } from '@/lib/utils'

const ADZUNA_BASE = 'https://api.adzuna.com/v1/api/jobs'

function fmtSalary(min?: number, max?: number, country = 'gb', predicted = false): string | undefined {
  const base = fmtSal(min, max, country)
  if (!base) return undefined
  return predicted ? `~${base}` : base
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { adzunaAppId: appId, adzunaAppKey: appKey } = await getDiscoveryApiKeys(auth.userId)
  if (!appId || !appKey) {
    return err('Adzuna is not configured. Add credentials in Settings → Keys & connections.', 501)
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
    raw = await fetch(url, { cache: 'no-store' })
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
