/**
 * GET /api/bundesagentur/search
 * Bundesagentur für Arbeit — German Federal Employment Agency.
 * Official German job board, ~1M active listings. Public API key, no registration needed.
 *
 * Params:
 *   q          string  — keywords (job title, skills)
 *   location   string  — German city or region
 *   radius     number  — search radius in km (10|25|50|100|150|200, default 25)
 *   page       number  — 1-based page
 *   size       number  — results per page (default 20, max 100)
 *   jobType    string  — fulltime | parttime | remote
 *   datePosted string  — today | 3days | week | month
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

const BASE = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs'
// Public API key — no registration required
const API_KEY = 'jobboerse-jobsuche'

const ARBEITSZEIT_MAP: Record<string, string> = {
  fulltime: 'VOLLZEIT',
  parttime: 'TEILZEIT',
  remote:   'HOMEOFFICE',
}

const DATE_MAP: Record<string, string> = {
  today:  '1',
  '3days': '3',
  week:   '7',
  month:  '30',
}

function fmtLocation(loc: { ort?: string; region?: string } | undefined): string {
  if (!loc) return ''
  return [loc.ort, loc.region].filter(Boolean).join(', ')
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const sp         = req.nextUrl.searchParams
  const q          = sp.get('q')?.trim() ?? ''
  const location   = sp.get('location')?.trim() ?? ''
  const radius     = sp.get('radius') ?? '25'
  const page       = Math.max(1, parseInt(sp.get('page') ?? '1', 10))
  const size       = Math.min(100, parseInt(sp.get('size') ?? '20', 10))
  const jobType    = sp.get('jobType') ?? ''
  const datePosted = sp.get('datePosted') ?? ''

  if (!q && !location) return err('q or location is required')

  const params = new URLSearchParams({
    page:  String(page - 1),  // API is 0-based
    size:  String(size),
    ...(q        && { was: q }),
    ...(location && { wo: location, umkreis: radius }),
  })

  const arbeitszeit = ARBEITSZEIT_MAP[jobType]
  if (arbeitszeit) params.set('arbeitszeit', arbeitszeit)

  const veroeffentlichtseit = DATE_MAP[datePosted]
  if (veroeffentlichtseit) params.set('veroeffentlichtseit', veroeffentlichtseit)

  let raw: Response
  try {
    raw = await fetch(`${BASE}?${params}`, {
      headers: { 'X-API-Key': API_KEY },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach Bundesagentur API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Bundesagentur API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as {
    maxErgebnisse?: number
    stellenangebote?: Array<{
      refnr:                      string
      titel:                      string
      beruf?:                     string
      arbeitgeber:                string
      arbeitsort?:                { ort?: string; plz?: string; region?: string }
      eintrittsdatum?:            string
      veroeffentlichungsdatum?:   string
      logoUrl?:                   string
      befristung?:                string
      arbeitszeit?:               string | string[]
    }>
  }

  const items = json.stellenangebote ?? []

  const jobs = items.map(r => {
    const encodedRef = encodeURIComponent(r.refnr)
    const jobTypes = Array.isArray(r.arbeitszeit) ? r.arbeitszeit : r.arbeitszeit ? [r.arbeitszeit] : []
    const isRemote = jobTypes.includes('HOMEOFFICE')
    const locStr   = fmtLocation(r.arbeitsort)

    return {
      id:          r.refnr,
      title:       r.titel,
      company:     r.arbeitgeber,
      logo:        r.logoUrl || null,
      location:    isRemote ? `Remote · ${locStr}`.replace(/ · $/, '') : locStr,
      salary:      undefined,   // not available in search results
      description: r.beruf ? truncate(r.beruf) : '',
      url:         `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodedRef}`,
      postedAt:    r.veroeffentlichungsdatum ?? null,
      jobType:     jobTypes.includes('VOLLZEIT') ? 'Full Time'
                 : jobTypes.includes('TEILZEIT') ? 'Part Time'
                 : jobTypes[0] ?? null,
      source:      'bundesagentur' as const,
    }
  })

  return ok({ jobs, total: json.maxErgebnisse ?? jobs.length, page })
}
