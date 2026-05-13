/**
 * GET /api/careerjet/search
 * CareerJet — 90+ countries including Eastern Europe (CZ, HU, RO, GR, SK, HR).
 * Free partner API. Register at: https://www.careerjet.com/partners/api
 *
 * Requires CAREERJET_AFFID in environment (Affiliate ID from partner registration).
 *
 * Supported locales include:
 *   cs_CZ (Czech), hu_HU (Hungary), ro_RO (Romania), el_GR (Greece),
 *   sk_SK (Slovakia), hr_HR (Croatia), pl_PL (Poland), pt_PT (Portugal),
 *   de_DE, en_GB, en_IE, en_US, fr_FR, nl_NL, es_ES, it_IT, etc.
 *
 * Params:
 *   q          string  — keywords
 *   location   string  — city or country
 *   locale     string  — IETF locale code (default: en_GB)
 *   page       number  — 1-based page
 *   pageSize   number  — results per page (default 20)
 *   sort       string  — relevance | date | salary
 *   jobType    string  — fulltime | parttime | contract
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

const BASE = 'https://search.api.careerjet.net/v4/query'

// Map country code to CareerJet locale
const LOCALE_MAP: Record<string, string> = {
  cz: 'cs_CZ', hu: 'hu_HU', ro: 'ro_RO', gr: 'el_GR', bg: 'bg_BG',
  sk: 'sk_SK', hr: 'hr_HR', si: 'sl_SI', lt: 'lt_LT', lv: 'lv_LV',
  ee: 'et_EE', pt: 'pt_PT', pl: 'pl_PL', de: 'de_DE', at: 'de_AT',
  ch: 'de_CH', fr: 'fr_FR', nl: 'nl_NL', be: 'nl_BE', es: 'es_ES',
  it: 'it_IT', gb: 'en_GB', ie: 'en_IE', us: 'en_US', ca: 'en_CA',
  au: 'en_AU', sg: 'en_SG', in: 'en_IN',
}

const CONTRACT_MAP: Record<string, string> = {
  fulltime:   'p',  // permanent/full-time
  parttime:   'p',
  contract:   'c',  // contract
  internship: 'i',  // internship
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const affid = process.env.CAREERJET_AFFID
  if (!affid) return err('CareerJet not configured. Register at careerjet.com/partners/api and add CAREERJET_AFFID to .env.local.', 501)

  const sp       = req.nextUrl.searchParams
  const q        = sp.get('q')?.trim() ?? ''
  const location = sp.get('location')?.trim() ?? ''
  const locale   = sp.get('locale')?.trim() || LOCALE_MAP[sp.get('country') ?? ''] || 'en_GB'
  const page     = Math.max(1, parseInt(sp.get('page') ?? '1', 10))
  const pageSize = Math.min(50, parseInt(sp.get('pageSize') ?? '20', 10))
  const sort     = sp.get('sort') ?? 'date'
  const jobType  = sp.get('jobType') ?? ''

  if (!q && !location) return err('q or location is required')

  const params = new URLSearchParams({
    affid,
    locale,
    sort,
    pagesize: String(pageSize),
    page:     String(page),
    // user_ip and user_agent are required by some partner agreements
    user_ip:    '1.1.1.1',
    user_agent: 'ApplyMate/1.0',
  })
  if (q)        params.set('keywords', q)
  if (location) params.set('location', location)
  if (CONTRACT_MAP[jobType]) params.set('contracttype', CONTRACT_MAP[jobType])

  let raw: Response
  try {
    raw = await fetch(`${BASE}?${params}`, { cache: 'no-store' })
  } catch { return err('Failed to reach CareerJet API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`CareerJet API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as {
    type?:    string
    hits?:    number
    pages?:   number
    jobs?:    Array<{
      title:       string
      locations:   string
      company:     string
      url:         string
      date:        string
      description: string
      salary?:     string
    }>
    message?: string
  }

  if (json.type === 'error') return err(`CareerJet: ${json.message ?? 'Unknown error'}`, 502)

  const jobs = (json.jobs ?? []).map((r, i) => ({
    id:          `cj-${page}-${i}`,
    title:       r.title,
    company:     r.company,
    logo:        null,
    location:    r.locations,
    salary:      r.salary || undefined,
    description: truncate(r.description ?? ''),
    url:         r.url,
    postedAt:    r.date ?? null,
    jobType:     null,
    source:      'careerjet' as const,
  }))

  return ok({ jobs, total: json.hits ?? jobs.length, pages: json.pages ?? 1, page })
}
