/**
 * lib/agent/discover.ts
 * Server-side job discovery for the Scout stage.
 *
 * Calls job APIs directly (no HTTP round-trip) so it can run inside the
 * Next.js Node runtime. Designed for batch discovery: given a list of
 * target roles × target locations, returns normalized job candidates ready
 * for DB insertion.
 *
 * Sources used (in priority order):
 *   1. Active Jobs DB (ATS direct-apply, exclude_ats_duplicate)
 *   2. LinkedIn 24h (freshest postings)
 *   3. Adzuna (EU) or JSearch (US/global) based on location
 */
import { truncate } from '@/lib/utils'
import { dedupJobs } from './dedup'

export interface DiscoveredJob {
  title:       string
  company:     string
  location:    string
  url:         string
  description: string
  salary:      string | null
  logo:        string | null
  source:      string
}

interface DiscoverParams {
  targetRoles:     string[]
  targetLocations: string[]  // empty → global search
  existingUrls:    Set<string>
  maxResults:      number    // total cap across all queries
}

// EU country code detector — mirrors unified route's EU_COUNTRY_MAP for consistency
const EU_LOC: Record<string, string> = {
  // Germany (DACH)
  germany: 'de', berlin: 'de', munich: 'de', münchen: 'de', hamburg: 'de',
  frankfurt: 'de', cologne: 'de', köln: 'de', stuttgart: 'de', dusseldorf: 'de', düsseldorf: 'de',
  deutschland: 'de',
  // Austria (DACH)
  austria: 'at', vienna: 'at', wien: 'at', graz: 'at', linz: 'at', österreich: 'at',
  // Switzerland (DACH)
  switzerland: 'ch', zurich: 'ch', zürich: 'ch', bern: 'ch', basel: 'ch',
  geneva: 'ch', lausanne: 'ch', schweiz: 'ch',
  // Ireland — full city/region coverage (mirrors unified route exactly)
  ireland: 'ie', 'republic of ireland': 'ie',
  dublin: 'ie', cork: 'ie', galway: 'ie', limerick: 'ie', waterford: 'ie',
  drogheda: 'ie', dundalk: 'ie', kilkenny: 'ie', sligo: 'ie', wexford: 'ie',
  athlone: 'ie', naas: 'ie', ennis: 'ie', letterkenny: 'ie', swords: 'ie',
  sandyford: 'ie', leopardstown: 'ie', 'grand canal': 'ie', docklands: 'ie',
  // UK
  uk: 'gb', 'united kingdom': 'gb', england: 'gb', britain: 'gb',
  london: 'gb', manchester: 'gb', edinburgh: 'gb', birmingham: 'gb',
  leeds: 'gb', glasgow: 'gb', liverpool: 'gb', bristol: 'gb',
  // Netherlands
  netherlands: 'nl', amsterdam: 'nl', rotterdam: 'nl', eindhoven: 'nl',
  utrecht: 'nl', 'the hague': 'nl', delft: 'nl',
  // France
  france: 'fr', paris: 'fr', lyon: 'fr', marseille: 'fr', toulouse: 'fr', bordeaux: 'fr',
  // Belgium
  belgium: 'be', brussels: 'be', antwerp: 'be', ghent: 'be',
  // Spain
  spain: 'es', madrid: 'es', barcelona: 'es', seville: 'es', bilbao: 'es', valencia: 'es',
  // Italy
  italy: 'it', rome: 'it', milan: 'it', turin: 'it', florence: 'it',
  // Poland
  poland: 'pl', warsaw: 'pl', krakow: 'pl', wroclaw: 'pl', poznan: 'pl', gdansk: 'pl',
  // Nordics
  sweden: 'se', stockholm: 'se', gothenburg: 'se',
  denmark: 'dk', copenhagen: 'dk',
  finland: 'fi', helsinki: 'fi',
  norway: 'no', oslo: 'no', bergen: 'no',
  // Portugal
  portugal: 'pt', lisbon: 'pt', porto: 'pt', braga: 'pt',
  // Czech / Hungary / Romania
  czechia: 'cz', 'czech republic': 'cz', prague: 'cz', brno: 'cz',
  hungary: 'hu', budapest: 'hu',
  romania: 'ro', bucharest: 'ro', cluj: 'ro',
  // Greece / Baltic
  greece: 'gr', athens: 'gr',
  lithuania: 'lt', vilnius: 'lt',
  latvia: 'lv', riga: 'lv',
  estonia: 'ee', tallinn: 'ee',
}

function detectEUCountry(loc: string): string | null {
  const l = loc.toLowerCase()
  for (const [kw, code] of Object.entries(EU_LOC)) {
    if (l.includes(kw)) return code
  }
  return null
}

function fmtLoc(remote?: boolean, locs?: string[]): string {
  const base = locs?.[0] ?? ''
  return remote ? `Remote${base ? ` · ${base}` : ''}` : base
}

// ── Source fetchers (server-side, no auth required) ───────────────────────────

async function fetchAts(q: string, location: string, key: string): Promise<DiscoveredJob[]> {
  const p = new URLSearchParams({
    title_filter: q, description_type: 'text',
    limit: '15', include_ai: 'true',
  })
  if (location) p.set('location_filter', location)
  try {
    const r = await fetch(`https://active-jobs-db.p.rapidapi.com/active-ats-7d?${p}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'active-jobs-db.p.rapidapi.com' },
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    })
    if (!r.ok) return []
    const json = await r.json()
    if (!Array.isArray(json)) return []
    return json.map((j: {
      title: string; organization: string; apply_url?: string; url: string
      locations_derived?: string[]; remote_derived?: boolean
      description_text?: string; organization_logo?: string | null
      ai_salary_minvalue?: number; ai_salary_maxvalue?: number; ai_salary_currency?: string
    }) => {
      const min = j.ai_salary_minvalue, max = j.ai_salary_maxvalue
      const cur = j.ai_salary_currency ?? ''
      const sym = cur === 'GBP' ? '£' : cur === 'EUR' ? '€' : cur === 'USD' ? '$' : ''
      return {
        title:       j.title,
        company:     j.organization,
        location:    fmtLoc(j.remote_derived, j.locations_derived),
        url:         j.apply_url || j.url,
        description: truncate(j.description_text ?? ''),
        salary:      min ? `${sym}${min.toLocaleString()}${max && max !== min ? `–${max.toLocaleString()}` : ''}/yr` : null,
        logo:        j.organization_logo ?? null,
        source:      'ats',
      }
    })
  } catch { return [] }
}

async function fetchLinkedIn(q: string, location: string, key: string): Promise<DiscoveredJob[]> {
  const p = new URLSearchParams({
    title_filter: q, description_type: 'text',
    limit: '15', include_ai: 'true', exclude_ats_duplicate: 'true',
  })
  if (location) p.set('location_filter', location)
  try {
    const r = await fetch(`https://linkedin-job-search-api.p.rapidapi.com/active-jb-24h?${p}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'linkedin-job-search-api.p.rapidapi.com' },
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    })
    if (!r.ok) return []
    const json = await r.json()
    if (!Array.isArray(json)) return []
    return json.map((j: {
      title: string; organization: string; external_apply_url?: string; url: string
      locations_derived?: string[]; remote_derived?: boolean
      description_text?: string; organization_logo?: string | null
      salary_raw?: string | null
    }) => ({
      title:       j.title,
      company:     j.organization,
      location:    fmtLoc(j.remote_derived, j.locations_derived),
      url:         j.external_apply_url || j.url,
      description: truncate(j.description_text ?? ''),
      salary:      j.salary_raw ?? null,
      logo:        j.organization_logo ?? null,
      source:      'linkedin',
    }))
  } catch { return [] }
}

async function fetchAdzuna(
  q: string, location: string,
  appId: string, appKey: string, country: string,
): Promise<DiscoveredJob[]> {
  const sym = { gb: '£', ie: '£', us: '$' }[country] ?? '€'
  const p = new URLSearchParams({
    app_id: appId, app_key: appKey,
    results_per_page: '15', sort_by: 'date', what: q,
  })
  if (location) p.set('where', location)
  try {
    const r = await fetch(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${p}`, {
      signal: AbortSignal.timeout(5_000), cache: 'no-store',
    })
    if (!r.ok) return []
    const json = await r.json() as { results?: Array<{
      title: string; company?: { display_name: string }; location?: { display_name: string }
      redirect_url: string; description?: string
      salary_min?: number; salary_max?: number
    }> }
    return (json.results ?? []).map(j => ({
      title:       j.title,
      company:     j.company?.display_name ?? '',
      location:    j.location?.display_name ?? '',
      url:         j.redirect_url,
      description: truncate(j.description ?? ''),
      salary:      j.salary_min ? `${sym}${Math.round(j.salary_min).toLocaleString()}${j.salary_max ? `–${Math.round(j.salary_max).toLocaleString()}` : ''}/yr` : null,
      logo:        null,
      source:      'adzuna',
    }))
  } catch { return [] }
}

async function fetchJSearch(q: string, location: string, key: string): Promise<DiscoveredJob[]> {
  const p = new URLSearchParams({
    query:       q + (location ? ` in ${location}` : ''),
    num_pages:   '1',
    date_posted: 'week',
  })
  try {
    const r = await fetch(`https://jsearch.p.rapidapi.com/search-v2?${p}`, {
      headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
      signal: AbortSignal.timeout(5_000), cache: 'no-store',
    })
    if (!r.ok) return []
    const json = await r.json() as { data?: { jobs?: Array<{
      job_title: string; employer_name?: string; job_apply_link: string
      job_city?: string; job_country?: string; job_is_remote?: boolean
      job_description?: string; job_min_salary?: number; job_max_salary?: number
    }> } }
    return (json.data?.jobs ?? []).map(j => {
      const loc = j.job_is_remote ? 'Remote' : [j.job_city, j.job_country].filter(Boolean).join(', ')
      return {
        title:       j.job_title,
        company:     j.employer_name ?? '',
        location:    loc,
        url:         j.job_apply_link,
        description: truncate(j.job_description ?? ''),
        salary:      j.job_min_salary ? `$${j.job_min_salary.toLocaleString()}${j.job_max_salary ? `–$${j.job_max_salary.toLocaleString()}` : ''}/yr` : null,
        logo:        null,
        source:      'jsearch',
      }
    })
  } catch { return [] }
}

// Indeed IE — mirrors unified route's Ireland strategy (countryCode=ie, verified working)
async function fetchIndeedIE(q: string, location: string, key: string): Promise<DiscoveredJob[]> {
  const p = new URLSearchParams({
    query:       q,
    countryCode: 'ie',
    sortType:    'date',
  })
  if (location) p.set('location', location || 'Ireland')
  try {
    const r = await fetch(`https://jobs-api14.p.rapidapi.com/v2/indeed/search?${p}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'jobs-api14.p.rapidapi.com' },
      signal: AbortSignal.timeout(5_000), cache: 'no-store',
    })
    if (!r.ok) return []
    const json = await r.json() as {
      data?: Array<{
        id: string; title: string
        company: { name: string; image?: string }
        location: { location?: string; country?: string }
        description?: string; applyUrl?: string
      }>
      hasError?: boolean
    }
    if (json.hasError || !Array.isArray(json.data)) return []
    return json.data.map(j => ({
      title:       j.title,
      company:     j.company?.name ?? '',
      location:    j.location?.location ?? j.location?.country ?? 'Ireland',
      url:         j.applyUrl ?? '',
      description: truncate(j.description ?? ''),
      salary:      null,
      logo:        j.company?.image ?? null,
      source:      'indeed',
    })).filter(j => j.url)
  } catch { return [] }
}

// ── IrishJobs.ie RSS (free, no key needed) ────────────────────────────────────

function slugifyIE(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')
}
function extractRssTag(xml: string, tag: string): string {
  return (xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
       ?? xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i')))?.[1]?.trim() ?? ''
}
function stripHtml(h: string): string {
  return h.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim()
}

async function fetchIrishJobsRss(q: string, location: string): Promise<DiscoveredJob[]> {
  const keySlug = slugifyIE(q)
  const locSlug = slugifyIE(location || 'ireland')
  const urls = [
    `https://www.irishjobs.ie/jobs/${keySlug}/in-${locSlug}?format=rss`,
    `https://www.irishjobs.ie/jobs/${keySlug}?format=rss`,
  ]
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'ApplyMate/1.0', 'Accept': 'application/rss+xml, text/xml' },
        signal: AbortSignal.timeout(7_000), cache: 'no-store',
      })
      if (!r.ok) continue
      const xml = await r.text()
      if (!xml.includes('<item')) continue
      return [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)].map((m, i) => {
        const it    = m[1]
        const title = stripHtml(extractRssTag(it, 'title'))
        const link  = extractRssTag(it, 'link')
        const desc  = stripHtml(extractRssTag(it, 'description'))
        const pub   = extractRssTag(it, 'pubDate')
        return {
          title,
          company:     desc.match(/Company[:\s]+([^|<\n]+)/i)?.[1]?.trim() ?? '',
          location:    desc.match(/Location[:\s]+([^|<\n]+)/i)?.[1]?.trim() ?? (location || 'Ireland'),
          url:         link,
          description: truncate(desc),
          salary:      desc.match(/Salary[:\s]+([^|<\n]+)/i)?.[1]?.trim() ?? null,
          logo:        null,
          source:      'irishjobs' as const,
        }
      }).filter(j => j.title && j.url)
    } catch { continue }
  }
  return []
}

// ── Main discovery function ───────────────────────────────────────────────────

export async function discoverJobs(params: DiscoverParams): Promise<DiscoveredJob[]> {
  const { targetRoles, targetLocations, existingUrls, maxResults } = params

  const apiKey    = process.env.RAPIDAPI_KEY   ?? ''
  const adzunaId  = process.env.ADZUNA_APP_ID  ?? ''
  const adzunaKey = process.env.ADZUNA_APP_KEY ?? ''

  const seen    = new Set(existingUrls)
  const results: DiscoveredJob[] = []

  const roles = targetRoles.filter(Boolean).slice(0, 3)
  const locs  = targetLocations.filter(Boolean).length
    ? targetLocations.slice(0, 2)
    : ['']   // empty string = no location filter

  for (const role of roles) {
    if (results.length >= maxResults) break

    for (const loc of locs) {
      if (results.length >= maxResults) break

      const country   = detectEUCountry(loc)
      const isIreland = country === 'ie'
      const isDACH    = country === 'de' || country === 'at' || country === 'ch'
      const isGB      = country === 'gb'
      const isEU      = country !== null
      const hasAdzuna = !!(adzunaId && adzunaKey)

      const fetchTasks: Array<Promise<DiscoveredJob[]>> = []

      if (isIreland) {
        // ── Ireland strategy (mirrors unified route exactly) ──────────────────
        // NOTE: Adzuna returns 404 for country=ie — excluded intentionally.
        // Verified sources: LinkedIn IE, Indeed IE, ATS, JSearch, IrishJobs RSS

        if (apiKey) {
          // 1. LinkedIn Ireland — broadened to country level for best coverage
          fetchTasks.push(fetchLinkedIn(role, loc ? `${loc}, Ireland` : 'Ireland', apiKey))
          // 2. Indeed IE — direct Irish listings via countryCode=ie
          fetchTasks.push(fetchIndeedIE(role, loc || 'Ireland', apiKey))
          // 3. ATS — career sites (Google IE, Meta IE, Stripe, HubSpot...)
          fetchTasks.push(fetchAts(role, loc || 'Ireland OR Dublin', apiKey))
        }
        // 4. IrishJobs.ie RSS — free, native, no key needed
        fetchTasks.push(fetchIrishJobsRss(role, loc || 'ireland'))

      } else if (isDACH) {
        // DACH: LinkedIn + Adzuna (strong in DE/AT/CH)
        if (apiKey)  fetchTasks.push(fetchLinkedIn(role, loc, apiKey))
        if (hasAdzuna) fetchTasks.push(fetchAdzuna(role, loc, adzunaId, adzunaKey, country!))
        if (apiKey)  fetchTasks.push(fetchAts(role, loc, apiKey))

      } else if (isGB) {
        // UK: Adzuna (best UK coverage) + LinkedIn + ATS
        if (hasAdzuna) fetchTasks.push(fetchAdzuna(role, loc, adzunaId, adzunaKey, 'gb'))
        if (apiKey)  fetchTasks.push(fetchLinkedIn(role, loc || 'United Kingdom', apiKey))
        if (apiKey)  fetchTasks.push(fetchAts(role, loc || 'United Kingdom', apiKey))

      } else if (isEU && hasAdzuna) {
        // Other EU: Adzuna + LinkedIn + ATS
        fetchTasks.push(fetchAdzuna(role, loc, adzunaId, adzunaKey, country!))
        if (apiKey) fetchTasks.push(fetchLinkedIn(role, loc, apiKey))
        if (apiKey) fetchTasks.push(fetchAts(role, loc, apiKey))

      } else {
        // Global / no location: ATS + LinkedIn + JSearch
        if (apiKey) {
          fetchTasks.push(fetchAts(role, loc, apiKey))
          fetchTasks.push(fetchLinkedIn(role, loc, apiKey))
          fetchTasks.push(fetchJSearch(role, loc, apiKey))
        }
      }

      // Free-source guarantee: no API keys configured → IrishJobs RSS as baseline
      if (!apiKey && !hasAdzuna) {
        fetchTasks.push(fetchIrishJobsRss(role, loc || 'ireland'))
      }

      const allResults = await Promise.all(fetchTasks)

      // Score and sort by location relevance before deduplication
      const locL = loc.toLowerCase()
      const scored = allResults.flat()
        .filter(j => j.url && j.title && j.company)
        .map(j => ({
          job:   j,
          score: (locL && j.location.toLowerCase().includes(locL)) ? 1 : 0,
        }))
        .sort((a, b) => b.score - a.score)

      for (const { job } of scored) {
        if (seen.has(job.url)) continue
        seen.add(job.url)
        results.push(job)
        if (results.length >= maxResults) break
      }
    }
  }

  // Deduplicate across sources before returning
  const beforeCount = results.length
  const deduped = dedupJobs(results)
  const removed = beforeCount - deduped.length
  if (removed > 0) {
    console.log(`[dedup] removed ${removed} duplicates, kept ${deduped.length} unique`)
  }
  return deduped
}
