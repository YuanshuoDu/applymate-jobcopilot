/**
 * GET /api/mantiks/search
 * Mantiks Job Postings API — multi-source job data (LinkedIn, Indeed, Glassdoor, WTTJ)
 * aggregated by company, with optional hiring-manager contact data.
 *
 * CREDIT MODEL: 1 credit per company found (not per job).
 * A company with 50 matching jobs still costs 1 credit.
 *
 * Unique value vs other APIs:
 *   - Hiring manager contacts (email, phone, LinkedIn URL)
 *   - Company-centric view: see all open roles at a company at once
 *   - Boolean search on title AND description
 *   - Multi-source in a single call
 *
 * Requires MANTIKS_API_KEY in environment.
 * Get yours + 50 free credits at: https://mantiks.io/job-postings-api
 *
 * Params:
 *   q          string   — job title keywords (supports boolean: "python AND backend")
 *   datePosted string   — today | week | month (default: week)
 *   jobBoard   string   — linkedin | indeed | glassdoor | welcome_to_the_jungle | (empty = all)
 *   limit      number   — max companies to return (default 10)
 *   withContact 0|1     — include hiring manager contacts (default 0, costs extra credits)
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

const BASE = 'https://api.mantiks.io'

const AGE_MAP: Record<string, number> = {
  today: 1,
  week:  7,
  month: 30,
}

interface MantiksContact {
  name?:         string
  job_title?:    string
  linkedin_url?: string
  email?:        string
  phone?:        string
}

interface MantiksJob {
  title:         string
  location?:     string
  posted_at?:    string
  date_creation?: string
  job_board?:    string
  job_board_url?: string
  url?:          string
  description?:  string
  contact?:      MantiksContact
}

interface MantiksCompany {
  company_name:  string
  job_count?:    number
  jobs:          MantiksJob[]
}

// Flattened job result (Mantiks returns company→jobs, we flatten to job→company)
export interface MantiksJobResult {
  id:             string
  title:          string
  company:        string
  location:       string
  description:    string
  url:            string
  postedAt:       string | null
  jobBoard:       string | null
  hiringManager:  {
    name:        string
    title:       string
    linkedinUrl: string
    email:       string | null
    phone:       string | null
  } | null
  source:         'mantiks'
}

function flattenJobs(companies: MantiksCompany[]): MantiksJobResult[] {
  const results: MantiksJobResult[] = []
  for (const company of companies) {
    for (let i = 0; i < (company.jobs ?? []).length; i++) {
      const j   = company.jobs[i]
      const url = j.job_board_url ?? j.url ?? ''
      const hm  = j.contact?.name ? {
        name:        j.contact.name,
        title:       j.contact.job_title ?? '',
        linkedinUrl: j.contact.linkedin_url ?? '',
        email:       j.contact.email ?? null,
        phone:       j.contact.phone ?? null,
      } : null

      results.push({
        id:            `mantiks-${company.company_name}-${i}`,
        title:         j.title,
        company:       company.company_name,
        location:      j.location ?? '',
        description:   truncate(j.description ?? ''),
        url,
        postedAt:      j.posted_at ?? j.date_creation ?? null,
        jobBoard:      j.job_board ?? null,
        hiringManager: hm,
        source:        'mantiks',
      })
    }
  }
  return results
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const apiKey = process.env.MANTIKS_API_KEY
  if (!apiKey) {
    return err(
      'Mantiks API not configured. Get 50 free credits at mantiks.io/job-postings-api and add MANTIKS_API_KEY to .env.local.',
      501,
    )
  }

  const sp          = req.nextUrl.searchParams
  const q           = sp.get('q')?.trim() ?? ''
  const datePosted  = sp.get('datePosted') ?? 'week'
  const jobBoard    = sp.get('jobBoard')?.trim() ?? ''
  const limit       = Math.min(50, parseInt(sp.get('limit') ?? '10', 10))

  if (!q) return err('q is required')

  const ageInDays = AGE_MAP[datePosted] ?? 7

  const params = new URLSearchParams({
    job_age_in_days: String(ageInDays),
  })

  // job_title accepts array notation on some endpoints; pass as repeated param
  params.append('job_title', q)

  if (jobBoard) params.set('job_board', jobBoard)

  let raw: Response
  try {
    raw = await fetch(`${BASE}/company/search?${params}`, {
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach Mantiks API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Mantiks API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const companies = await raw.json() as MantiksCompany[]

  if (!Array.isArray(companies)) return err('Unexpected Mantiks API response', 502)

  const limited  = companies.slice(0, limit)
  const jobs     = flattenJobs(limited)
  const withHM   = jobs.filter(j => j.hiringManager !== null).length

  return ok({
    jobs,
    meta: {
      companiesFound: companies.length,
      totalJobs:      jobs.length,
      withHiringManager: withHM,
      creditsUsed:    limited.length,  // 1 credit per company
    },
  })
}
