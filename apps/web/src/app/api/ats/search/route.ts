/**
 * GET /api/ats/search
 * Active Jobs DB — direct ATS/career-site job listings (175k+ organizations).
 * Users apply directly on the employer's site; no third-party redirect.
 *
 * Params:
 *   q           string   — title keywords
 *   location    string   — free-text location (supports "City OR Country" syntax)
 *   page        number   — 1-based page (default 1)
 *   experience  string   — entry | mid | senior | lead
 *   jobType     string   — fulltime | parttime | contract | internship
 *   remote      0|1      — remote-only filter
 *   datePosted  string   — today | week | month
 *   companySize string   — small (<200) | medium (<1000) | large (1000+)
 *
 * Requires RAPIDAPI_KEY in environment.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

const HOST      = 'active-jobs-db.p.rapidapi.com'
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

const COMPANY_SIZE_MAP: Record<string, { gte?: string; lte?: string }> = {
  small:  { lte: '200' },
  medium: { gte: '201', lte: '999' },
  large:  { gte: '1000' },
}

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
  const tail = unit === 'YEAR' ? '/yr' : unit === 'HOUR' ? '/hr' : ''
  return max && max !== min
    ? `${sym}${min.toLocaleString()}–${sym}${max.toLocaleString()}${tail}`
    : `${sym}${min.toLocaleString()}${tail}`
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const apiKey = process.env.RAPIDAPI_KEY
  if (!apiKey) return err('RapidAPI key not configured. Add RAPIDAPI_KEY to .env.local.', 501)

  const sp          = req.nextUrl.searchParams
  const q           = sp.get('q')?.trim()
  const location    = sp.get('location')?.trim() ?? ''
  const page        = Math.max(1, parseInt(sp.get('page') ?? '1', 10))
  const experience  = sp.get('experience') ?? ''
  const jobType     = sp.get('jobType') ?? ''
  const remote      = sp.get('remote') === '1'
  const datePosted  = sp.get('datePosted') ?? ''
  const companySize = sp.get('companySize') ?? ''

  if (!q) return err('q is required')

  const params = new URLSearchParams({
    title_filter:     q,
    description_type: 'text',
    offset:           String((page - 1) * PAGE_SIZE),
    limit:            String(PAGE_SIZE),
    include_ai:       'true',
  })

  if (location)                      params.set('location_filter', location)
  if (remote)                        params.set('remote', 'true')
  if (SENIORITY_MAP[experience])     params.set('seniority_filter', SENIORITY_MAP[experience])
  if (TYPE_MAP[jobType])             params.set('type_filter', TYPE_MAP[jobType])

  const sizeBounds = COMPANY_SIZE_MAP[companySize]
  if (sizeBounds?.lte) params.set('employees_lte', sizeBounds.lte)
  if (sizeBounds?.gte) params.set('employees_gte', sizeBounds.gte)

  const threshold = dateThreshold(datePosted)
  if (threshold) params.set('date_filter', threshold)

  let raw: Response
  try {
    raw = await fetch(`https://${HOST}/active-ats-7d?${params}`, {
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach Active Jobs DB', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Active Jobs DB error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as Array<{
    id:                   string
    title:                string
    organization:         string
    organization_logo?:   string | null
    locations_derived?:   string[]
    remote_derived?:      boolean
    url:                  string
    apply_url?:           string | null
    date_posted?:         string
    description_text?:    string
    employment_type?:     string[]
    seniority?:           string | null
    // AI fields
    ai_salary_currency?:         string | null
    ai_salary_minvalue?:         number | null
    ai_salary_maxvalue?:         number | null
    ai_salary_unittext?:         string | null
    ai_key_skills?:              string[] | null
    ai_work_arrangement?:        string | null
    ai_experience_level?:        string | null
    ai_core_responsibilities?:   string | null
    ai_requirements_summary?:    string | null
    ai_education_requirements?:  string[] | null
    ai_taxonomies_a?:            string[] | null
    ai_visa_sponsorship?:        boolean | null
    // LinkedIn company fields (if include_li=true)
    linkedin_org_industry?:      string | null
    linkedin_org_employees?:     number | null
    linkedin_org_headquarters?:  string | null
  }>

  if (!Array.isArray(json)) return err('Unexpected Active Jobs DB response', 502)

  const jobs = json.map(r => {
    const salary = fmtAiSalary(
      r.ai_salary_minvalue, r.ai_salary_maxvalue,
      r.ai_salary_currency, r.ai_salary_unittext,
    )

    const loc = r.remote_derived
      ? `Remote${r.locations_derived?.[0] ? ` · ${r.locations_derived[0]}` : ''}`
      : (r.locations_derived?.[0] ?? '')

    return {
      id:                  r.id,
      title:               r.title,
      company:             r.organization,
      logo:                r.organization_logo ?? null,
      location:            loc,
      salary,
      description:         truncate(r.description_text ?? ''),
      url:                 r.apply_url || r.url,
      postedAt:            r.date_posted ?? null,
      jobType:             r.employment_type?.[0]?.replace('_', ' ') ?? null,
      seniority:           r.seniority ?? null,
      directApply:         true,          // ATS jobs always direct apply
      keySkills:           r.ai_key_skills ?? [],
      workArrangement:     r.ai_work_arrangement ?? null,
      experienceLevel:     r.ai_experience_level ?? null,
      coreResponsibilities: r.ai_core_responsibilities ?? null,
      educationRequired:   r.ai_education_requirements ?? [],
      taxonomies:          r.ai_taxonomies_a ?? [],
      visaSponsorship:     r.ai_visa_sponsorship ?? null,
      industry:            r.linkedin_org_industry ?? null,
      companySize:         r.linkedin_org_employees ?? null,
      companyHQ:           r.linkedin_org_headquarters ?? null,
      source:              'ats' as const,
    }
  })

  const total = jobs.length >= PAGE_SIZE ? page * PAGE_SIZE + PAGE_SIZE : page * PAGE_SIZE
  return ok({ jobs, total, page })
}
