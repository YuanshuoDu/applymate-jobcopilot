/**
 * GET /api/mantiks/company
 * Mantiks — track all open jobs at a specific company.
 * Given a company website, returns every active job posting across all job boards.
 *
 * Use case: User is targeting a specific company → see all their open roles.
 *
 * Requires MANTIKS_API_KEY in environment.
 *
 * Params:
 *   website    string   — company website (e.g. "stripe.com")
 *   keyword    string   — optional keyword filter (job title or description)
 *   datePosted string   — today | week | month (default: month)
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

const BASE = 'https://api.mantiks.io'

const AGE_MAP: Record<string, number> = {
  today: 1, week: 7, month: 30,
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const apiKey = process.env.MANTIKS_API_KEY
  if (!apiKey) return err('Mantiks API not configured. Add MANTIKS_API_KEY to .env.local.', 501)

  const sp         = req.nextUrl.searchParams
  const website    = sp.get('website')?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
  const keyword    = sp.get('keyword')?.trim() ?? ''
  const datePosted = sp.get('datePosted') ?? 'month'

  if (!website) return err('website is required (e.g. stripe.com)')

  const ageInDays = AGE_MAP[datePosted] ?? 30
  const websiteEncoded = encodeURIComponent(website)

  const params = new URLSearchParams({
    website:     websiteEncoded,
    age_in_days: String(ageInDays),
  })
  if (keyword) params.set('keyword', keyword)

  let raw: Response
  try {
    raw = await fetch(`${BASE}/company/jobs?${params}`, {
      headers: { 'X-API-KEY': apiKey },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach Mantiks API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Mantiks API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as {
    jobs?: Array<{
      job_title:     string
      location?:     string
      date_creation?: string
      posted_at?:    string
      job_board_url?: string
      url?:          string
      description?:  string
      job_board?:    string
    }>
  }

  const jobs = (json.jobs ?? []).map((j, i) => ({
    id:          `mantiks-co-${i}`,
    title:       j.job_title,
    company:     website,
    location:    j.location ?? '',
    description: truncate(j.description ?? ''),
    url:         j.job_board_url ?? j.url ?? '',
    postedAt:    j.posted_at ?? j.date_creation ?? null,
    jobBoard:    j.job_board ?? null,
    source:      'mantiks' as const,
  }))

  return ok({ jobs, total: jobs.length, website })
}
