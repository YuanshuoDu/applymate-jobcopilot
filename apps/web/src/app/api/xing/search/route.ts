/**
 * GET /api/xing/search
 * Xing job search — dominant platform for DACH (Germany, Austria, Switzerland).
 * Native salary data; no AI extraction needed. Uses jobs-api14 (RapidAPI).
 *
 * Params:
 *   q           string   — title keywords
 *   location    string   — city or country (German names work best, English also accepted)
 *   page        number   — 1-based (uses token-based pagination internally)
 *   experience  string   — entry | mid | senior | lead
 *   jobType     string   — fulltime | parttime | contract | internship
 *   remote      0|1      — remote / hybrid filter
 *   datePosted  string   — today | week | month
 *   salaryMin   number   — minimum yearly salary in EUR
 *   token       string   — raw pagination token (overrides page)
 *
 * Requires RAPIDAPI_KEY in environment.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

const HOST = 'jobs-api14.p.rapidapi.com'

// Xing career level values
const CAREER_LEVEL_MAP: Record<string, string> = {
  entry:  'student;entry',
  mid:    'professional',
  senior: 'professional;manager',
  lead:   'manager;executive;seniorExecutive',
}

// Xing employment type values
const EMPLOYMENT_TYPE_MAP: Record<string, string> = {
  fulltime:   'fulltime',
  parttime:   'parttime',
  contract:   'contractor',
  internship: 'intern',
}

// Xing date posted values
const DATE_POSTED_MAP: Record<string, string> = {
  today: 'day',
  week:  'week',
  month: 'month',
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const apiKey = process.env.RAPIDAPI_KEY
  if (!apiKey) return err('RapidAPI key not configured. Add RAPIDAPI_KEY to .env.local.', 501)

  const sp         = req.nextUrl.searchParams
  const q          = sp.get('q')?.trim() ?? ''
  const location   = sp.get('location')?.trim() ?? ''
  const experience = sp.get('experience') ?? ''
  const jobType    = sp.get('jobType') ?? ''
  const remote     = sp.get('remote') === '1'
  const datePosted = sp.get('datePosted') ?? ''
  const salaryMin  = sp.get('salaryMin') ? Number(sp.get('salaryMin')) * 1000 : null
  const token      = sp.get('token')?.trim() ?? ''

  // Xing requires either a token or a query
  if (!q && !token) return err('q is required')

  const params = new URLSearchParams()

  if (token) {
    // Token-based pagination — other params are optional but can be passed
    params.set('token', token)
  } else {
    params.set('query', q)
    if (location) params.set('location', location)

    const xingDate = DATE_POSTED_MAP[datePosted]
    if (xingDate) params.set('datePosted', xingDate)

    const careerLevel = CAREER_LEVEL_MAP[experience]
    if (careerLevel) params.set('careerLevels', careerLevel)

    const empType = EMPLOYMENT_TYPE_MAP[jobType]
    if (empType) params.set('employmentTypes', empType)

    // Remote options: pass remote;hybrid when remote is requested, onSite when not
    if (remote) {
      params.set('remoteOptions', 'remote;hybrid')
    }

    if (salaryMin && salaryMin > 0) params.set('minimumSalary', String(salaryMin))
  }

  let raw: Response
  try {
    raw = await fetch(`https://${HOST}/v2/xing/search?${params}`, {
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach Xing API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Xing API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as {
    data?: Array<{
      id:             string
      title:          string
      company:        string
      location?:      string
      employmentType?: string
      dateUpdated?:   string
      image?:         string
      salary?:        { currency: string; minimum?: number; maximum?: number } | null
    }>
    meta?:   { position?: number; count?: number; nextToken?: string }
    _links?: { next?: string }
    hasError?: boolean
    errors?:   Array<{ code: number; message: string }>
  }

  if (json.hasError) {
    const msg = json.errors?.[0]?.message ?? 'Unknown error'
    return err(`Xing API error: ${msg}`, 502)
  }

  const items = json.data ?? []

  const jobs = items.map(r => {
    let salary: string | undefined
    if (r.salary?.minimum || r.salary?.maximum) {
      const sym  = r.salary.currency === 'EUR' ? '€' : r.salary.currency === 'CHF' ? 'CHF' : r.salary.currency
      const min  = r.salary.minimum
      const max  = r.salary.maximum
      salary = (min && max && min !== max)
        ? `${sym} ${min.toLocaleString()}–${max.toLocaleString()}/yr`
        : min
        ? `${sym} ${min.toLocaleString()}/yr`
        : max
        ? `${sym} ${max.toLocaleString()}/yr`
        : undefined
    }

    return {
      id:          r.id,
      title:       r.title,
      company:     r.company,
      logo:        r.image || null,
      location:    r.location ?? '',
      salary,
      description: '',   // detail endpoint needed for description
      url:         '',   // detail endpoint needed for applyUrl
      postedAt:    r.dateUpdated ?? null,
      jobType:     r.employmentType ?? null,
      source:      'xing' as const,
    }
  })

  return ok({
    jobs,
    nextToken: json.meta?.nextToken ?? null,
    total:     json.meta?.count ?? jobs.length,
  })
}
