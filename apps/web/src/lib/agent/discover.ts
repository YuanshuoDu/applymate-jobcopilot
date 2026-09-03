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
import { getDiscoveryApiAccess, type DiscoveryApiAccess } from '@/lib/discovery-api-keys'
import { isRuntimeFeatureEnabled } from '@/lib/runtime-feature-flags'
import { credentialCacheScope, createDiscoveryCacheKey, getDiscoveryCache, runDiscoverySingleflight, setDiscoveryCache } from '@/lib/discovery/cache'
import { recordDiscoveryOptimization } from '@/lib/discovery/metrics'
import { loadProviderStates, reserveProviderQuota } from '@/lib/discovery/quota'
import { executeProviderPlan, type ProviderCall } from '@/lib/discovery/provider-router'
import { compareShadowJobs } from '@/lib/discovery/shadow'
import { reportJobApiJobs, trackedJobApiFetch } from '@/lib/api-usage/job-api-usage'
import { dedupJobs } from './dedup'
import { resolveLocation } from './location-resolver'
import { fetchCleanJobData } from './sources/cleanjobdata'
import { fetchFantasticJobs } from './sources/fantasticjobs'

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

export interface DiscoverProviderEvent {
  provider: string
  role: string
  location: string
  jobsReturned: number
  status: 'success' | 'error'
  latencyMs: number
}

export interface DiscoverParams {
  userId?:          string
  targetRoles:     string[]
  targetLocations: string[]  // empty → global search
  existingUrls:    Set<string>
  maxResults:      number    // total cap across all queries
  onProviderCall?:  (event: DiscoverProviderEvent) => void | Promise<void>
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

type ScoutCredentialSource = 'platform' | 'user' | 'public'

type ScoutFetchContext = {
  userId?: string
  rapidapiCredentialSource: Exclude<ScoutCredentialSource, 'public'>
  adzunaCredentialSource: Exclude<ScoutCredentialSource, 'public'>
}

type ScoutProviderExecution = () => Promise<DiscoveredJob[]>

function providerCallKey(call: ProviderCall): string {
  return `${call.id}|${Object.entries(call.params).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&')}`
}

function providerCredentialSource(provider: string, access: DiscoveryApiAccess): ScoutCredentialSource {
  if (provider === 'cleanjobdata' || provider === 'fantasticjobs') return 'platform'
  if (provider === 'adzuna') return access.adzunaSource === 'user' ? 'user' : 'platform'
  if (provider.startsWith('rapidapi-')) return access.rapidapiSource === 'user' ? 'user' : 'platform'
  return 'public'
}

function envDiscoveryAccess(): DiscoveryApiAccess {
  const adzunaAppId = process.env.ADZUNA_APP_ID?.trim() ?? ''
  const adzunaAppKey = process.env.ADZUNA_APP_KEY?.trim() ?? ''
  const rapidapiKey = process.env.RAPIDAPI_KEY?.trim() ?? ''
  const cleanJobDataApiKey = process.env.CLEANJOBDATA_API_KEY?.trim() ?? ''
  const fantasticJobsApiKey = process.env.FANTASTICJOBS_API_KEY?.trim() || process.env.FANTASTIC_JOBS_API_KEY?.trim() || ''
  return {
    adzunaAppId,
    adzunaAppKey,
    rapidapiKey,
    cleanJobDataApiKey,
    ...(fantasticJobsApiKey ? { fantasticJobsApiKey } : {}),
    adzunaSource: adzunaAppId && adzunaAppKey ? 'platform' : 'none',
    rapidapiSource: rapidapiKey ? 'platform' : 'none',
  }
}

function countFreshScoutJobs(items: readonly DiscoveredJob[], seen: ReadonlySet<string>, location: string): number {
  return new Set(items
    .filter(job => job.url && job.title && job.company && (!location || matchesTargetLocation(job.location, location)))
    .filter(job => !seen.has(job.url))
    .map(job => job.url)).size
}

function recordScoutDecisions(
  decisions: Awaited<ReturnType<typeof executeProviderPlan<DiscoveredJob>>>['decisions'],
  access: DiscoveryApiAccess,
  userId: string | undefined,
  role: string,
  location: string,
): void {
  void Promise.all(decisions.map(decision => recordDiscoveryOptimization({
    userId,
    eventType: decision.action === 'selected' ? 'provider_selected' : 'provider_skipped',
    provider: decision.provider,
    credentialScope: providerCredentialSource(decision.provider, access),
    reasonCode: decision.reason,
    metadata: { route: 'worker_discovery', role, location, quotaBand: decision.quotaBand },
  })))
}

// ── Source fetchers (server-side, no auth required) ───────────────────────────

async function fetchAts(q: string, location: string, key: string, context: ScoutFetchContext): Promise<DiscoveredJob[]> {
  const p = new URLSearchParams({
    title_filter: q, description_type: 'text',
    limit: '15', include_ai: 'true',
  })
  if (location) p.set('location_filter', location)
  try {
    const r = await trackedJobApiFetch(`https://active-jobs-db.p.rapidapi.com/active-ats-7d?${p}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'active-jobs-db.p.rapidapi.com' },
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    }, { provider: 'rapidapi-active-jobs', operation: 'list', credentialSource: context.rapidapiCredentialSource, userId: context.userId })
    if (!r.ok) return []
    const json = await r.json()
    if (!Array.isArray(json)) return []
    await reportJobApiJobs(r, json.length)
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

async function fetchLinkedIn(q: string, location: string, key: string, context: ScoutFetchContext): Promise<DiscoveredJob[]> {
  const p = new URLSearchParams({
    title_filter: q, description_type: 'text',
    limit: '15', include_ai: 'true', exclude_ats_duplicate: 'true',
  })
  if (location) p.set('location_filter', location)
  try {
    const r = await trackedJobApiFetch(`https://linkedin-job-search-api.p.rapidapi.com/active-jb-24h?${p}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'linkedin-job-search-api.p.rapidapi.com' },
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    }, { provider: 'rapidapi-linkedin', operation: 'list', credentialSource: context.rapidapiCredentialSource, userId: context.userId })
    if (!r.ok) return []
    const json = await r.json()
    if (!Array.isArray(json)) return []
    await reportJobApiJobs(r, json.length)
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
  appId: string, appKey: string, country: string, context: ScoutFetchContext,
): Promise<DiscoveredJob[]> {
  const sym = { gb: '£', ie: '£', us: '$' }[country] ?? '€'
  const p = new URLSearchParams({
    app_id: appId, app_key: appKey,
    results_per_page: '15', sort_by: 'date', what: q,
  })
  if (location) p.set('where', location)
  try {
    const r = await trackedJobApiFetch(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${p}`, {
      signal: AbortSignal.timeout(5_000), cache: 'no-store',
    }, { provider: 'adzuna', operation: 'list', credentialSource: context.adzunaCredentialSource, userId: context.userId })
    if (!r.ok) return []
    const json = await r.json() as { results?: Array<{
      title: string; company?: { display_name: string }; location?: { display_name: string }
      redirect_url: string; description?: string
      salary_min?: number; salary_max?: number
    }> }
    await reportJobApiJobs(r, json.results?.length ?? 0)
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

async function fetchJSearch(q: string, location: string, key: string, context: ScoutFetchContext): Promise<DiscoveredJob[]> {
  const p = new URLSearchParams({
    query:       q + (location ? ` in ${location}` : ''),
    num_pages:   '1',
    date_posted: 'week',
  })
  try {
    const r = await trackedJobApiFetch(`https://jsearch.p.rapidapi.com/search-v2?${p}`, {
      headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
      signal: AbortSignal.timeout(5_000), cache: 'no-store',
    }, { provider: 'rapidapi-jsearch', operation: 'list', credentialSource: context.rapidapiCredentialSource, userId: context.userId })
    if (!r.ok) return []
    const json = await r.json() as { data?: { jobs?: Array<{
      job_title: string; employer_name?: string; job_apply_link: string
      job_city?: string; job_country?: string; job_is_remote?: boolean
      job_description?: string; job_min_salary?: number; job_max_salary?: number
    }> } }
    await reportJobApiJobs(r, json.data?.jobs?.length ?? 0)
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
async function fetchIndeedIE(q: string, location: string, key: string, context: ScoutFetchContext): Promise<DiscoveredJob[]> {
  const p = new URLSearchParams({
    query:       q,
    countryCode: 'ie',
    sortType:    'date',
  })
  if (location) p.set('location', location || 'Ireland')
  try {
    const r = await trackedJobApiFetch(`https://jobs-api14.p.rapidapi.com/v2/indeed/search?${p}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'jobs-api14.p.rapidapi.com' },
      signal: AbortSignal.timeout(5_000), cache: 'no-store',
    }, { provider: 'rapidapi-jobs-api14', operation: 'list', credentialSource: context.rapidapiCredentialSource, userId: context.userId })
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
    await reportJobApiJobs(r, json.data.length)
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

async function fetchIrishJobsRss(q: string, location: string, userId?: string): Promise<DiscoveredJob[]> {
  const keySlug = slugifyIE(q)
  const locSlug = slugifyIE(location || 'ireland')
  const urls = [
    `https://www.irishjobs.ie/jobs/${keySlug}/in-${locSlug}?format=rss`,
    `https://www.irishjobs.ie/jobs/${keySlug}?format=rss`,
  ]
  for (const url of urls) {
    try {
      const r = await trackedJobApiFetch(url, {
        headers: { 'User-Agent': 'ApplyMate/1.0', 'Accept': 'application/rss+xml, text/xml' },
        signal: AbortSignal.timeout(7_000), cache: 'no-store',
      }, { provider: 'irishjobs', operation: 'list', credentialSource: 'public', userId })
      if (!r.ok) continue
      const xml = await r.text()
      if (!xml.includes('<item')) continue
      const jobs = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)].map((m, i) => {
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
      await reportJobApiJobs(r, jobs.length)
      return jobs
    } catch { continue }
  }
  return []
}

// ── Main discovery function ───────────────────────────────────────────────────

export async function discoverJobs(params: DiscoverParams): Promise<DiscoveredJob[]> {
  const { userId } = params

  if (userId) {
    try {
      if (!await isRuntimeFeatureEnabled('worker_discovery', userId)) return []
    } catch (error) {
      console.warn('[discover] Platform discovery control unavailable', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  const access = userId ? await getDiscoveryApiAccess(userId) : envDiscoveryAccess()
  const keys = access
  const fantasticShadowEnabled = Boolean(keys.fantasticJobsApiKey && userId) && await isRuntimeFeatureEnabled('fantasticjobs_shadow', userId!).catch(() => false)
  const cacheKey = createDiscoveryCacheKey({
    query: {
      roles: params.targetRoles.filter(Boolean).map(role => role.trim().toLowerCase()).sort().join('\u001f'),
      locations: params.targetLocations.filter(Boolean).map(location => location.trim().toLowerCase()).sort().join('\u001f'),
      existingUrls: [...params.existingUrls].sort().join('\u001f'),
      maxResults: params.maxResults,
      fantasticShadow: fantasticShadowEnabled,
    },
    providers: ['worker-discovery-v1'],
    credentialScope: credentialCacheScope({
      userId: userId ?? 'anonymous',
      providerScopes: { worker: userId ? 'user' : 'public' },
    }),
  })
  const cached = await getDiscoveryCache<DiscoveredJob[]>(cacheKey)
  if (cached) {
    void recordDiscoveryOptimization({ userId, eventType: 'cache_hit', credentialScope: userId ? 'user' : 'public', requestsAvoided: 1, metadata: { route: 'worker_discovery', layer: cached.layer } })
    return cached.value
  }

  const flight = await runDiscoverySingleflight(cacheKey, async () => {
    const secondLook = await getDiscoveryCache<DiscoveredJob[]>(cacheKey)
    if (secondLook) return secondLook.value
    const value = await discoverJobsUncached(params, fantasticShadowEnabled, keys)
    await setDiscoveryCache(cacheKey, value)
    return value
  })
  if (flight.joined) {
    void recordDiscoveryOptimization({ userId, eventType: 'singleflight_hit', credentialScope: userId ? 'user' : 'public', requestsAvoided: 1, metadata: { route: 'worker_discovery' } })
  }
  return flight.value
}

async function discoverJobsUncached(params: DiscoverParams, fantasticShadowEnabled: boolean, keys: DiscoveryApiAccess): Promise<DiscoveredJob[]> {
  const { userId, targetRoles, targetLocations, existingUrls, maxResults } = params

  const apiKey    = keys.rapidapiKey
  const adzunaId  = keys.adzunaAppId
  const adzunaKey = keys.adzunaAppKey
  const cleanJobDataKey = keys.cleanJobDataApiKey
  const fantasticJobsKey = keys.fantasticJobsApiKey
  const fantasticShadowActive = fantasticShadowEnabled && Boolean(fantasticJobsKey)

  const seen    = new Set(existingUrls)
  const results: DiscoveredJob[] = []

  // Provider health is stable enough for one Scout run. Load it once rather
  // than once per role/location pair; quota reservations remain atomic per
  // request and still protect concurrent Scout runs.
  const available = new Set<string>(['irishjobs'])
  if (apiKey) {
    available.add('rapidapi-active-jobs')
    available.add('rapidapi-linkedin')
    available.add('rapidapi-jobs-api14')
    available.add('rapidapi-jsearch')
  }
  if (adzunaId && adzunaKey) available.add('adzuna')
  if (cleanJobDataKey) available.add('cleanjobdata')
  if (fantasticShadowActive) available.add('fantasticjobs')
  const scopeGroups = new Map<ScoutCredentialSource, string[]>([
    ['platform', []], ['user', []], ['public', []],
  ])
  for (const provider of available) scopeGroups.get(providerCredentialSource(provider, keys))?.push(provider)
  const stateEntries = await Promise.all([...scopeGroups.entries()]
    .map(async ([scope, providers]) => [scope, await loadProviderStates(providers, scope)] as const))
  const states = new Map(stateEntries.flatMap(([, values]) => [...values.entries()]))
  const reserve = (call: ProviderCall) => reserveProviderQuota({
    provider: call.id,
    operation: 'list',
    credentialSource: providerCredentialSource(call.id, keys),
    expectedJobs: call.expectedJobs ?? 20,
  })

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
      const fetchContext: ScoutFetchContext = {
        userId,
        rapidapiCredentialSource: keys.rapidapiSource === 'user' ? 'user' : 'platform',
        adzunaCredentialSource: keys.adzunaSource === 'user' ? 'user' : 'platform',
      }
      const calls: ProviderCall[] = []
      const executions = new Map<string, ScoutProviderExecution>()
      const addProvider = (
        id: string,
        params: Record<string, string>,
        execute: ScoutProviderExecution,
        expectedJobs = 20,
      ) => {
        const call: ProviderCall = { id, params, expectedJobs }
        if (calls.some(existing => existing.id === id)) return
        calls.push(call)
        executions.set(providerCallKey(call), execute)
      }

      if (isIreland) {
        // ── Ireland strategy (mirrors unified route exactly) ──────────────────
        // NOTE: Adzuna returns 404 for country=ie — excluded intentionally.
        // Verified sources: LinkedIn IE, Indeed IE, ATS, JSearch, IrishJobs RSS

        if (apiKey) {
          // 1. LinkedIn Ireland — broadened to country level for best coverage
          const linkedInLocation = loc ? `${loc}, Ireland` : 'Ireland'
          addProvider('rapidapi-linkedin', { role, location: linkedInLocation }, () => fetchLinkedIn(role, linkedInLocation, apiKey, fetchContext), 15)
          // 2. Indeed IE — direct Irish listings via countryCode=ie
          const indeedLocation = loc || 'Ireland'
          addProvider('rapidapi-jobs-api14', { role, location: indeedLocation }, () => fetchIndeedIE(role, indeedLocation, apiKey, fetchContext), 15)
          // 3. ATS — career sites (Google IE, Meta IE, Stripe, HubSpot...)
          const atsLocation = loc || 'Ireland OR Dublin'
          addProvider('rapidapi-active-jobs', { role, location: atsLocation }, () => fetchAts(role, atsLocation, apiKey, fetchContext), 15)
        }
        // 4. IrishJobs.ie RSS — free, native, no key needed
        const irishJobsLocation = loc || 'ireland'
        addProvider('irishjobs', { role, location: irishJobsLocation }, () => fetchIrishJobsRss(role, irishJobsLocation, userId))

      } else if (isDACH) {
        // DACH: LinkedIn + Adzuna (strong in DE/AT/CH)
        if (apiKey) addProvider('rapidapi-linkedin', { role, location: loc }, () => fetchLinkedIn(role, loc, apiKey, fetchContext), 15)
        if (hasAdzuna) addProvider('adzuna', { role, location: loc, country: country! }, () => fetchAdzuna(role, loc, adzunaId, adzunaKey, country!, fetchContext), 15)
        if (apiKey) addProvider('rapidapi-active-jobs', { role, location: loc }, () => fetchAts(role, loc, apiKey, fetchContext), 15)

      } else if (isGB) {
        // UK: Adzuna (best UK coverage) + LinkedIn + ATS
        if (hasAdzuna) addProvider('adzuna', { role, location: loc, country: 'gb' }, () => fetchAdzuna(role, loc, adzunaId, adzunaKey, 'gb', fetchContext), 15)
        if (apiKey) {
          const linkedInLocation = loc || 'United Kingdom'
          addProvider('rapidapi-linkedin', { role, location: linkedInLocation }, () => fetchLinkedIn(role, linkedInLocation, apiKey, fetchContext), 15)
          const atsLocation = loc || 'United Kingdom'
          addProvider('rapidapi-active-jobs', { role, location: atsLocation }, () => fetchAts(role, atsLocation, apiKey, fetchContext), 15)
        }

      } else if (isEU && hasAdzuna) {
        // Other EU: Adzuna + LinkedIn + ATS
        addProvider('adzuna', { role, location: loc, country: country! }, () => fetchAdzuna(role, loc, adzunaId, adzunaKey, country!, fetchContext), 15)
        if (apiKey) {
          addProvider('rapidapi-linkedin', { role, location: loc }, () => fetchLinkedIn(role, loc, apiKey, fetchContext), 15)
          addProvider('rapidapi-active-jobs', { role, location: loc }, () => fetchAts(role, loc, apiKey, fetchContext), 15)
        }

      } else {
        // Global / no location: ATS + LinkedIn + JSearch
        if (apiKey) {
          addProvider('rapidapi-active-jobs', { role, location: loc }, () => fetchAts(role, loc, apiKey, fetchContext), 15)
          addProvider('rapidapi-linkedin', { role, location: loc }, () => fetchLinkedIn(role, loc, apiKey, fetchContext), 15)
          addProvider('rapidapi-jsearch', { role, location: loc }, () => fetchJSearch(role, loc, apiKey, fetchContext), 15)
        }
      }

      // IrishJobs is a useful free fallback only for Irish or unrestricted
      // searches. It must not pollute a London/Berlin request with Irish jobs.
      if (!apiKey && !hasAdzuna && (isIreland || !loc)) {
        const irishJobsLocation = loc || 'ireland'
        addProvider('irishjobs', { role, location: irishJobsLocation }, () => fetchIrishJobsRss(role, irishJobsLocation, userId))
      }

      // CleanJobData is a normalized supplementary feed, not an ATS. Keep it
      // additive and let the existing location filter/dedup pipeline arbitrate.
      if (cleanJobDataKey) {
        addProvider('cleanjobdata', { role, country: country ?? '' }, () => fetchCleanJobData({
          apiKey: cleanJobDataKey,
          userId,
          title: role,
          countryCode: country ?? undefined,
          maxPages: 1,
          maxResults: Math.min(20, maxResults - results.length),
        }))
      }

      const execute = async (call: ProviderCall) => {
        const startedAt = Date.now()
        try {
          const items = await (executions.get(providerCallKey(call))?.() ?? Promise.resolve([]))
          await params.onProviderCall?.({ provider: call.id, role, location: loc, jobsReturned: items.length, status: 'success', latencyMs: Date.now() - startedAt })
          return items
        } catch (error) {
          await params.onProviderCall?.({ provider: call.id, role, location: loc, jobsReturned: 0, status: 'error', latencyMs: Date.now() - startedAt })
          throw error
        }
      }
      const visible = await executeProviderPlan({
        calls,
        availableProviders: available,
        states,
        targetResults: Math.max(1, maxResults - results.length),
        execute,
        count: items => countFreshScoutJobs(items, seen, loc),
        reserve,
      })
      recordScoutDecisions(visible.decisions, keys, userId, role, loc)

      const shadow = fantasticShadowActive
        ? await executeProviderPlan({
            calls: [{ id: 'fantasticjobs', params: { role, location: loc }, expectedJobs: 20 }],
            availableProviders: available,
            states,
            targetResults: Number.MAX_SAFE_INTEGER,
            execute: () => fetchFantasticJobs({ apiKey: fantasticJobsKey!, title: role, location: loc, userId }),
            count: items => items.length,
            reserve,
          })
        : { items: [] as DiscoveredJob[], decisions: [] }
      if (fantasticShadowActive) recordScoutDecisions(shadow.decisions, keys, userId, role, loc)

      const allResults = visible.items
      const shadowResults = shadow.items

      if (fantasticShadowActive) {
        const evidence = compareShadowJobs(allResults, shadowResults)
        void recordDiscoveryOptimization({
          userId, eventType: 'shadow_comparison', provider: 'fantasticjobs', credentialScope: 'platform',
          jobsReturned: evidence.shadowJobs, netNewJobs: evidence.netNewJobs,
          validApplyUrls: evidence.validApplyUrls, completeDescriptions: evidence.completeDescriptions,
          metadata: { route: 'worker_discovery', role, location: loc },
        })
      }

      // Enforce the requested location before ranking. Source-side location
      // filters are advisory, so without this a fallback can leak other cities.
      const locL = loc.toLowerCase()
      const scored = allResults.flat()
        .filter(j => j.url && j.title && j.company && (!loc || matchesTargetLocation(j.location, loc)))
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

function matchesTargetLocation(jobLocation: string, targetLocation: string) {
  const job = jobLocation.trim().toLowerCase()
  if (!job) return false
  const target = targetLocation.trim().toLowerCase()
  if (job.includes(target)) return true
  const resolved = resolveLocation(targetLocation)
  return resolved.isCountry && resolved.dbTerms.some(term => job.includes(term))
}
