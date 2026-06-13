/**
 * GET /api/indeed/search
 * Indeed job search via jobs-api14 (RapidAPI).
 * Covers US, EU, and global markets. Requires countryCode.
 *
 * Params:
 *   q           string   — keywords / job title
 *   location    string   — city or region
 *   countryCode string   — 2-letter country code (default: us)
 *   sortType    string   — relevance | date (default: date)
 *   token       string   — pagination token from previous response
 *
 * Requires RAPIDAPI_KEY in environment.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

const HOST = 'jobs-api14.p.rapidapi.com'

// Map our internal country codes to Indeed country codes
const COUNTRY_CODE_MAP: Record<string, string> = {
  gb: 'gb', uk: 'gb',
  de: 'de', at: 'at', ch: 'ch',
  nl: 'nl', fr: 'fr', es: 'es', it: 'it', pl: 'pl',
  be: 'be', se: 'se', dk: 'dk', fi: 'fi', no: 'no',
  us: 'us', ca: 'ca', au: 'au',
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const apiKey = process.env.RAPIDAPI_KEY
  if (!apiKey) return err('RapidAPI key not configured. Add RAPIDAPI_KEY to .env.local.', 501)

  const sp          = req.nextUrl.searchParams
  const q           = sp.get('q')?.trim() ?? ''
  const location    = sp.get('location')?.trim() ?? ''
  const countryCode = COUNTRY_CODE_MAP[(sp.get('countryCode') ?? 'us').toLowerCase()] ?? 'us'
  const sortType    = sp.get('sortType') ?? 'date'
  const token       = sp.get('token')?.trim() ?? ''

  if (!q && !token) return err('q is required')

  const params = new URLSearchParams()
  if (token) {
    params.set('token', token)
  } else {
    if (q)        params.set('query', q)
    if (location) params.set('location', location)
    params.set('countryCode', countryCode)
    params.set('sortType', sortType === 'relevance' ? 'relevance' : 'date')
  }

  let raw: Response
  try {
    raw = await fetch(`https://${HOST}/v2/indeed/search?${params}`, {
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach Indeed API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Indeed API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as {
    data?: Array<{
      id:                     string
      title:                  string
      company:                { name: string; image?: string; addresses?: string[] }
      location:               { location?: string; country?: string; countryCode?: string }
      description?:           string
      applyUrl?:              string
      datePublishedTimestamp?: number
    }>
    meta?:   { count?: number; nextToken?: string }
    hasError?: boolean
    errors?:   Array<{ code: number; message: string }>
  }

  if (json.hasError) {
    const msg = json.errors?.[0]?.message ?? 'Unknown error'
    return err(`Indeed API error: ${msg}`, 502)
  }

  const items = json.data ?? []

  const jobs = items.map(r => ({
    id:          r.id,
    title:       r.title,
    company:     r.company?.name ?? '',
    logo:        r.company?.image || null,
    location:    r.location?.location ?? r.location?.country ?? '',
    salary:      undefined,
    description: truncate(r.description ?? ''),
    url:         r.applyUrl ?? '',
    // datePublishedTimestamp appears to be a relative/encoded value; skip unsafe parsing
    postedAt:    null as string | null,
    jobType:     null as string | null,
    source:      'indeed' as const,
  }))

  return ok({
    jobs,
    nextToken: json.meta?.nextToken ?? null,
    total:     json.meta?.count ?? jobs.length,
  })
}
