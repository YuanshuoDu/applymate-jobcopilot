/**
 * GET /api/linkedin/search
 * Params: q, location, page, experience, jobType, remote, datePosted
 * Proxies linkedin-job-search-api (RapidAPI) — active-jb-1h endpoint.
 * Requires RAPIDAPI_KEY in environment.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

const HOST      = 'linkedin-job-search-api.p.rapidapi.com'
const PAGE_SIZE = 20

const SENIORITY_MAP: Record<string, string> = {
  entry:  'Entry level,Internship',
  mid:    'Associate,Mid-Senior level',
  senior: 'Mid-Senior level',
  lead:   'Director,Executive',
}

const TYPE_MAP: Record<string, string> = {
  fulltime:   'FULL_TIME',
  parttime:   'PART_TIME',
  contract:   'CONTRACTOR',
  internship: 'INTERN',
}

function dateThreshold(preset: string): string | null {
  const offsets: Record<string, number> = { today: 1, week: 7, month: 30 }
  const days = offsets[preset]
  if (!days) return null
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

function fmtAiSalary(
  min?: number | null, max?: number | null,
  currency?: string | null, unit?: string | null,
): string | undefined {
  if (!min) return undefined
  const sym  = ({ USD: '$', GBP: '£', EUR: '€' } as Record<string, string>)[currency ?? ''] ?? ''
  const tail = unit === 'YEAR' ? '/yr' : unit === 'HOUR' ? '/hr' : ''
  return max && max !== min
    ? `${sym}${min.toLocaleString()}–${sym}${max.toLocaleString()}${tail}`
    : `${sym}${min.toLocaleString()}${tail}`
}

/**
 * Coerce salary_raw to a display string.
 * LinkedIn API may return a string, or a Google Jobs schema JSON object like:
 *   { "@type": "MonetaryAmount", "currency": "EUR", "value": { "value": 50000, ... } }
 */
/** LinkedIn returns partial logo paths like /v2/D4E0BAQE... — prepend CDN domain */
function fixLogoUrl(logo?: string | null): string | null {
  if (!logo) return null
  if (logo.startsWith('http')) return logo
  if (logo.startsWith('/')) return `https://media.licdn.com${logo}`
  return logo
}

function safeSalary(raw: unknown): string | undefined {
  if (!raw) return undefined
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    const cur  = r.currency as string | undefined
    const val  = r.value as Record<string, unknown> | undefined
    const num  = val?.value ?? r.minValue ?? r.value
    const unit = (val?.unitText ?? r.unitText) as string | undefined
    if (num && typeof num === 'number') {
      return fmtAiSalary(
        r.minValue as number ?? num as number,
        r.maxValue as number ?? num as number,
        cur, unit,
      ) ?? `$${num.toLocaleString()}${unit === 'YEAR' ? '/yr' : ''}`
    }
    return undefined
  }
  return undefined
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const apiKey = process.env.RAPIDAPI_KEY
  if (!apiKey) return err('RapidAPI key not configured. Add RAPIDAPI_KEY to .env.local.', 501)

  const sp         = req.nextUrl.searchParams
  const q          = sp.get('q')?.trim()
  const location   = sp.get('location')?.trim() ?? ''
  const page       = Math.max(1, parseInt(sp.get('page') ?? '1', 10))
  const experience = sp.get('experience') ?? ''
  const jobType    = sp.get('jobType') ?? ''
  const remote     = sp.get('remote') === '1'
  const datePosted = sp.get('datePosted') ?? ''

  if (!q) return err('q is required')

  const params = new URLSearchParams({
    title_filter:     q,
    description_type: 'text',
    offset:           String((page - 1) * PAGE_SIZE),
    limit:            String(PAGE_SIZE),
    include_ai:       'true',
  })
  if (location)                    params.set('location_filter', location)
  if (remote)                      params.set('remote', 'true')
  if (SENIORITY_MAP[experience])   params.set('seniority_filter', SENIORITY_MAP[experience])
  if (TYPE_MAP[jobType])           params.set('type_filter', TYPE_MAP[jobType])
  const threshold = dateThreshold(datePosted)
  if (threshold)                   params.set('date_filter', threshold)

  let raw: Response
  try {
    raw = await fetch(`https://${HOST}/active-jb-1h?${params}`, {
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach LinkedIn API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`LinkedIn API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as Array<{
    id:                   string
    title:                string
    organization:         string
    organization_logo?:   string | null
    locations_derived?:   string[]
    remote_derived?:      boolean
    salary_raw?:          string | null
    employment_type?:     string[]
    url:                  string
    date_posted?:         string
    description_text?:    string
    external_apply_url?:  string | null
    seniority?:           string | null
    directapply?:         boolean
    ai_salary_currency?:  string | null
    ai_salary_minvalue?:  number | null
    ai_salary_maxvalue?:  number | null
    ai_salary_unittext?:  string | null
    ai_key_skills?:       string[] | null
    ai_work_arrangement?: string | null
  }>

  if (!Array.isArray(json)) return err('Unexpected LinkedIn API response', 502)

  const jobs = json.map(r => {
    const salary = safeSalary(r.salary_raw)
      ?? fmtAiSalary(r.ai_salary_minvalue, r.ai_salary_maxvalue, r.ai_salary_currency, r.ai_salary_unittext)

    const loc = r.remote_derived
      ? `Remote${r.locations_derived?.[0] ? ` · ${r.locations_derived[0]}` : ''}`
      : (r.locations_derived?.[0] ?? '')

    return {
      id:             r.id,
      title:          r.title,
      company:        r.organization,
      logo:           fixLogoUrl(r.organization_logo),
      location:       loc,
      salary,
      description:    truncate(r.description_text ?? ''),
      url:            r.external_apply_url || r.url,
      postedAt:       r.date_posted ?? null,
      jobType:        r.employment_type?.[0]?.replace('_', ' ') ?? null,
      seniority:      r.seniority ?? null,
      directApply:    r.directapply ?? false,
      keySkills:      r.ai_key_skills ?? [],
      workArrangement: r.ai_work_arrangement ?? null,
      source:         'linkedin' as const,
    }
  })

  const total = jobs.length >= PAGE_SIZE ? page * PAGE_SIZE + PAGE_SIZE : page * PAGE_SIZE
  return ok({ jobs, total, page })
}
