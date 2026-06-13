/**
 * GET /api/internships/search
 * Internships API — specialized internship job listings (free, 200 req/mo).
 * Two data sources in a single endpoint: company career sites + LinkedIn job boards.
 * Returns up to 10 jobs per call (API limit); use `page` to paginate.
 *
 * Params:
 *   q           string   — title keywords
 *   location    string   — free-text location
 *   page        number   — 1-based page (default 1)
 *   remote      0|1      — remote-only
 *   datePosted  string   — today | week | month
 *
 * Requires RAPIDAPI_KEY in environment.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

const HOST      = 'internships-api.p.rapidapi.com'
const PAGE_SIZE = 10  // API hard limit

function dateThreshold(preset: string): string | null {
  const days: Record<string, number> = { today: 1, week: 7, month: 30 }
  const d = days[preset]
  return d ? new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10) : null
}

function fmtAiSalary(
  min?: number | null, max?: number | null,
  cur?: string | null, unit?: string | null,
): string | undefined {
  if (!min) return undefined
  const sym  = ({ USD: '$', GBP: '£', EUR: '€' } as Record<string, string>)[cur ?? ''] ?? ''
  const tail = unit === 'YEAR' ? '/yr' : unit === 'HOUR' ? '/hr' : unit === 'MONTH' ? '/mo' : ''
  return max && max !== min
    ? `${sym}${min.toLocaleString()}–${sym}${max.toLocaleString()}${tail}`
    : `${sym}${min.toLocaleString()}${tail}`
}

// Shared job shape returned by both career-site and job-board responses
interface RawJob {
  id:                        string
  title:                     string
  organization:              string
  organization_logo?:        string | null
  locations_derived?:        string[]
  remote_derived?:           boolean
  salary_raw?:               string | null
  employment_type?:          string[]
  url:                       string
  date_posted?:              string
  description_text?:         string
  source?:                   string
  source_type?:              string
  // LinkedIn job board extras
  recruiter_name?:           string | null
  recruiter_url?:            string | null
  linkedin_org_industry?:    string | null
  linkedin_org_employees?:   number | null
  linkedin_org_headquarters?: string | null
  // AI fields
  ai_salary_currency?:         string | null
  ai_salary_minvalue?:         number | null
  ai_salary_maxvalue?:         number | null
  ai_salary_unittext?:         string | null
  ai_key_skills?:              string[] | null
  ai_work_arrangement?:        string | null
  ai_core_responsibilities?:   string | null
  ai_requirements_summary?:    string | null
  ai_visa_sponsorship?:        boolean | null
  ai_hiring_manager_name?:     string | null
  ai_hiring_manager_email_address?: string | null
}

function normalizeJob(r: RawJob) {
  const salary = r.salary_raw
    ?? fmtAiSalary(r.ai_salary_minvalue, r.ai_salary_maxvalue, r.ai_salary_currency, r.ai_salary_unittext)

  const loc = r.remote_derived
    ? `Remote${r.locations_derived?.[0] ? ` · ${r.locations_derived[0]}` : ''}`
    : (r.locations_derived?.[0] ?? '')

  const isAts = r.source_type === 'ats' || r.source_type === 'career-site'

  return {
    id:                  r.id,
    title:               r.title,
    company:             r.organization,
    logo:                r.organization_logo ?? null,
    location:            loc,
    salary,
    description:         truncate(r.description_text ?? ''),
    url:                 r.url,
    postedAt:            r.date_posted ?? null,
    jobType:             'Internship',
    directApply:         isAts,
    keySkills:           r.ai_key_skills ?? [],
    workArrangement:     r.ai_work_arrangement ?? null,
    coreResponsibilities: r.ai_core_responsibilities ?? null,
    visaSponsorship:     r.ai_visa_sponsorship ?? null,
    recruiter:           r.recruiter_name
      ? { name: r.recruiter_name, url: r.recruiter_url ?? null }
      : null,
    hiringManager:       r.ai_hiring_manager_name
      ? { name: r.ai_hiring_manager_name, email: r.ai_hiring_manager_email_address ?? null }
      : null,
    industry:            r.linkedin_org_industry ?? null,
    companySize:         r.linkedin_org_employees ?? null,
    companyHQ:           r.linkedin_org_headquarters ?? null,
    dataSource:          r.source_type ?? 'unknown',
    source:              'internships' as const,
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const apiKey = process.env.RAPIDAPI_KEY
  if (!apiKey) return err('RapidAPI key not configured. Add RAPIDAPI_KEY to .env.local.', 501)

  const sp         = req.nextUrl.searchParams
  const q          = sp.get('q')?.trim() ?? ''
  const location   = sp.get('location')?.trim() ?? ''
  const page       = Math.max(1, parseInt(sp.get('page') ?? '1', 10))
  const remote     = sp.get('remote') === '1'
  const datePosted = sp.get('datePosted') ?? ''

  const offset = (page - 1) * PAGE_SIZE
  const params = new URLSearchParams({
    offset:           String(offset),
    description_type: 'text',
    include_ai:       'true',
  })
  if (q)         params.set('title_filter', q)
  if (location)  params.set('location_filter', location)
  if (remote)    params.set('remote', 'true')

  const threshold = dateThreshold(datePosted)
  if (threshold) params.set('date_filter', threshold)

  let raw: Response
  try {
    raw = await fetch(`https://${HOST}/active-jb-7d?${params}`, {
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach Internships API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Internships API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json()
  if (!Array.isArray(json)) return err('Unexpected Internships API response', 502)

  const jobs = (json as RawJob[]).map(normalizeJob)
  const total = jobs.length >= PAGE_SIZE ? page * PAGE_SIZE + PAGE_SIZE : page * PAGE_SIZE
  return ok({ jobs, total, page })
}
