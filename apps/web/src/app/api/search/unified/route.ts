/**
 * GET /api/search/unified
 * Params:
 *   q              string   — keywords (boolean supported: "python AND backend")
 *   location?      string   — free text (city, country, "Remote")
 *   remote?        0|1      — force remote-only
 *   jobType?       fulltime|parttime|contract|internship
 *   datePosted?    today|week|month|any
 *   experience?    entry|mid|senior|lead
 *   salaryMin?     number   — in local currency (k)
 *   salaryMax?     number
 *   noCache?       1        — bypass cache (for debugging)
 *
 * Returns:
 *   { jobs: JobResult[], meta: { sourcesUsed, sourceBreakdown, totalRaw,
 *     durationMs, routing, salaryContext, topSkills, cached, withHiringManager } }
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate, fmtSalary } from '@/lib/utils'
import { getDiscoveryApiAccess } from '@/lib/discovery-api-keys'
import { trackedJobApiFetch, type ApiCredentialSource } from '@/lib/api-usage/job-api-usage'
import { fetchCleanJobData } from '@/lib/agent/sources/cleanjobdata'
import { fetchFantasticJobs } from '@/lib/agent/sources/fantasticjobs'
import { getClientIp } from '@/lib/request-client-ip'
import { isRuntimeFeatureEnabled } from '@/lib/runtime-feature-flags'
import { credentialCacheScope, createDiscoveryCacheKey, getDiscoveryCache, runDiscoverySingleflight, setDiscoveryCache } from '@/lib/discovery/cache'
import { recordDiscoveryOptimization } from '@/lib/discovery/metrics'
import { loadProviderStates, reserveProviderQuota } from '@/lib/discovery/quota'
import { executeProviderPlan, type ProviderCall } from '@/lib/discovery/provider-router'
import { compareShadowJobs } from '@/lib/discovery/shadow'
import { cleanSearchTitle, postFilter, queryKeywords, scoreSearchJobs, smartDedup, type SearchFilters, type SearchJob } from './search-quality'

// ── Infrastructure ────────────────────────────────────────────────────────────

const SOURCE_TIMEOUT_MS       = 5_000             // drop a source after 5 s
const MIN_RESULTS_FOR_FALLBACK = 5                // expand sources when < 5 results

// Sources that guarantee remote=true on every returned job

// Wraps a promise with a hard timeout; returns fallback on expiry.
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(res => setTimeout(() => res(fallback), ms))])
}

type JobResult = SearchJob

function usageMeta(filters: SearchFilters, provider: string, operation: string, source: ApiCredentialSource = 'public') {
  return { provider, operation, credentialSource: source, userId: filters.usage?.userId }
}

function rapidSource(filters: SearchFilters): ApiCredentialSource {
  return filters.usage?.rapidapiSource === 'user' ? 'user' : 'platform'
}

type SourceId = JobResult['source']

interface SourceCall {
  id:     SourceId
  params: Record<string, string>
}

interface RouterDecision {
  reasoning: string
  sources:   SourceCall[]
}

// ── Smart heuristic router ────────────────────────────────────────────────────
// Routing is deterministic (fast, free, 100% reliable).
// AI is reserved for result scoring / match scoring where it adds real value.

const EU_COUNTRY_MAP: Record<string, string> = {
  // Germany (DACH)
  germany: 'de', berlin: 'de', munich: 'de', hamburg: 'de', frankfurt: 'de', cologne: 'de',
  stuttgart: 'de', dusseldorf: 'de', deutschland: 'de', münchen: 'de', köln: 'de',
  // Austria (DACH)
  austria: 'at', vienna: 'at', wien: 'at', österreich: 'at', graz: 'at', linz: 'at',
  // Switzerland (DACH)
  switzerland: 'ch', zurich: 'ch', zürich: 'ch', bern: 'ch', basel: 'ch',
  schweiz: 'ch', geneva: 'ch', genf: 'ch', lausanne: 'ch',
  // Ireland — comprehensive city + region + tech cluster coverage
  ireland: 'ie', 'republic of ireland': 'ie', 'irish': 'ie',
  // Major cities
  dublin: 'ie', cork: 'ie', galway: 'ie', limerick: 'ie', waterford: 'ie',
  // Other cities & towns
  drogheda: 'ie', dundalk: 'ie', kilkenny: 'ie', tralee: 'ie', sligo: 'ie',
  wexford: 'ie', athlone: 'ie', naas: 'ie', ennis: 'ie', letterkenny: 'ie',
  tullamore: 'ie', carlow: 'ie', portlaoise: 'ie', navan: 'ie', mullingar: 'ie',
  swords: 'ie', malahide: 'ie', bray: 'ie', greystones: 'ie',
  // Dublin tech cluster (major employer campuses)
  sandyford: 'ie', leopardstown: 'ie', citywest: 'ie', clonskeagh: 'ie',
  'grand canal': 'ie', 'docklands': 'ie', 'dublin 2': 'ie', 'dublin 4': 'ie',
  'silicon docks': 'ie',
  // UK
  uk: 'gb', 'united kingdom': 'gb', england: 'gb', britain: 'gb',
  london: 'gb', manchester: 'gb', edinburgh: 'gb', birmingham: 'gb', leeds: 'gb', glasgow: 'gb',
  // Netherlands
  netherlands: 'nl', amsterdam: 'nl', rotterdam: 'nl', eindhoven: 'nl', utrecht: 'nl', 'the hague': 'nl',
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
  portugal: 'pt', lisbon: 'pt', porto: 'pt', oporto: 'pt', braga: 'pt',
  // Czech Republic
  'czech republic': 'cz', czechia: 'cz', prague: 'cz', brno: 'cz', ostrava: 'cz',
  // Hungary
  hungary: 'hu', budapest: 'hu', debrecen: 'hu',
  // Romania
  romania: 'ro', bucharest: 'ro', cluj: 'ro', timisoara: 'ro', iasi: 'ro',
  // Greece
  greece: 'gr', athens: 'gr', thessaloniki: 'gr',
  // Slovakia
  slovakia: 'sk', bratislava: 'sk', kosice: 'sk',
  // Croatia
  croatia: 'hr', zagreb: 'hr', split: 'hr',
  // Bulgaria
  bulgaria: 'bg', sofia: 'bg',
  // Baltic states
  lithuania: 'lt', vilnius: 'lt',
  latvia: 'lv', riga: 'lv',
  estonia: 'ee', tallinn: 'ee',
  // Luxembourg & small states
  luxembourg: 'lu',
}

// Routing tiers by country code
const DACH_COUNTRIES     = new Set(['de', 'at', 'ch'])
// Adzuna covers these EU countries well
// NOTE: 'ie' (Ireland) is intentionally excluded — Adzuna API returns 404 for country=ie,
// and GB+where=Ireland returns ~1 result. Ireland has its own dedicated routing above.
const ADZUNA_EU          = new Set(['gb', 'de', 'at', 'ch', 'fr', 'nl', 'es', 'it', 'pl', 'be', 'se', 'dk', 'fi', 'no', 'pt'])
// CareerJet covers these (Eastern EU + others)
const CAREERJET_EU       = new Set(['cz', 'hu', 'ro', 'gr', 'sk', 'hr', 'bg', 'lt', 'lv', 'ee', 'lu'])

// Ireland-specific: top multinational tech employers with EU HQ in Dublin
// When searching for these roles in IE, Mantiks company search is especially valuable
const DUBLIN_TECH_COMPANIES = new Set([
  'google', 'meta', 'facebook', 'linkedin', 'stripe', 'hubspot', 'salesforce',
  'amazon', 'aws', 'microsoft', 'apple', 'twitter', 'x', 'airbnb', 'booking',
  'paypal', 'ebay', 'vmware', 'oracle', 'accenture', 'deloitte', 'kpmg', 'pwc',
  'pfizer', 'abbott', 'allergan', 'medtronic', 'boston scientific', 'zoetis',
])

// Irish tech roles that dominate the Dublin market
const IRELAND_TECH_KEYWORDS = /\b(software|engineer|developer|data|cloud|devops|fintech|pharma|medtech|sre|platform|backend|frontend|fullstack|security|product|ux|ui)\b/i

const JOBICY_GEO: Record<string, string> = {
  gb: 'uk', ie: 'ireland',
  nl: 'netherlands', de: 'germany', fr: 'europe', at: 'europe', ch: 'europe',
  be: 'europe', es: 'europe', it: 'europe', pl: 'europe', se: 'europe',
  dk: 'europe', fi: 'europe', no: 'europe', pt: 'europe',
  cz: 'europe', hu: 'europe', ro: 'europe', gr: 'europe',
  sk: 'europe', hr: 'europe', bg: 'europe', lt: 'europe', lv: 'europe', ee: 'europe',
}

// CareerJet locale lookup (for Eastern EU countries not on Adzuna)
const CAREERJET_LOCALE: Record<string, string> = {
  cz: 'cs_CZ', hu: 'hu_HU', ro: 'ro_RO', gr: 'el_GR', bg: 'bg_BG',
  sk: 'sk_SK', hr: 'hr_HR', lt: 'lt_LT', lv: 'lv_LV', ee: 'et_EE', lu: 'fr_LU',
  pt: 'pt_PT', pl: 'pl_PL', de: 'de_DE', at: 'de_AT', ch: 'de_CH',
  fr: 'fr_FR', nl: 'nl_NL', es: 'es_ES', it: 'it_IT', gb: 'en_GB', ie: 'en_IE',
}

// ── Query Analysis ────────────────────────────────────────────────────────────

interface QueryAnalysis {
  isCompanyQuery: boolean   // "jobs at stripe" → use Mantiks company endpoint
  hasBoolean:     boolean   // "python AND backend" → pass raw to boolean-capable APIs
  seniorityHint:  string    // detected seniority from query text
  isRemote:       boolean   // remote intent detected in query
  titleOnly:      string    // query stripped of location/meta words
}

function analyzeQuery(q: string, f: SearchFilters): QueryAnalysis {
  const l = q.toLowerCase()
  const isCompanyQuery = /\b(jobs at|hiring at|careers at|openings at|at [a-z]+)\b/.test(l)
    || /^(stripe|shopify|netflix|spotify|booking|adyen|klarna|n26|revolut|wise)\b/.test(l)

  const seniorityWords = l.match(/\b(junior|jr|entry|mid|senior|sr|lead|principal|staff|director|vp)\b/)
  const seniorityHint  = seniorityWords?.[1] ?? f.experience

  return {
    isCompanyQuery,
    hasBoolean:  /\b(AND|OR|NOT)\b/.test(q),
    seniorityHint,
    isRemote:    f.remote || /\b(remote|wfh|work from home|distributed)\b/.test(l),
    titleOnly:   q.replace(/\b(jobs at|hiring at|careers at|remote|hybrid)\b/gi, '').replace(/\s+/g, ' ').trim(),
  }
}

function detectCountry(text: string): string | null {
  const t = text.toLowerCase()
  for (const [kw, code] of Object.entries(EU_COUNTRY_MAP)) {
    if (t.includes(kw)) return code
  }
  return null
}

function smartRouter(q: string, f: SearchFilters, qa?: QueryAnalysis): RouterDecision {
  const ql           = (q + ' ' + f.location).toLowerCase()
  const isRem        = f.remote || /\b(remote|anywhere|worldwide|distributed)\b/.test(ql)
  const isInternship = f.jobType === 'internship' || /\b(intern|internship)\b/.test(ql)
  const country      = detectCountry(ql)
  const isEU         = country !== null
  const isUS         = !isEU && /\b(usa|united states|new york|san francisco|seattle|chicago|boston|austin)\b/.test(ql)

  // Env-key availability (avoid allocating slots for unconfigured optional sources)
  const hasCareerjet = !!process.env.CAREERJET_AFFID
  const hasReed      = !!process.env.REED_API_KEY
  const hasMantiks   = !!process.env.MANTIKS_API_KEY
  const hasCleanJobData = !!f.discovery?.cleanJobDataApiKey

  const loc   = f.location || ''
  const title = cleanSearchTitle(q)
  const companyQueryName = qa?.isCompanyQuery
    ? q.replace(/\b(jobs at|hiring at|careers at|openings at)\b/gi, '').trim()
    : undefined
  const sources: SourceCall[] = []

  const cleanJobDataParams = (companyName?: string): Record<string, string> => ({
    q: companyName ? '' : title || q,
    ...(country ? { country } : {}),
    ...(companyName ? { companyName } : {}),
    ...(isRem ? { remote: 'true' } : {}),
    ...(f.datePosted && f.datePosted !== 'any' ? { datePosted: f.datePosted } : {}),
    ...(f.experience ? { experience: f.experience } : {}),
    ...(f.jobType ? { jobType: f.jobType } : {}),
    ...(f.salaryMin ? { salaryMin: String(f.salaryMin) } : {}),
    ...(f.salaryMax ? { salaryMax: String(f.salaryMax) } : {}),
  })
  const addCleanJobData = (companyName?: string) => {
    if (hasCleanJobData && !sources.some(source => source.id === 'cleanjobdata')) {
      sources.push({ id: 'cleanjobdata', params: cleanJobDataParams(companyName) })
    }
  }

  // Shared params builder — only include non-empty filter values
  const baseParams = (locationFilter: string): Record<string, string> => {
    const p: Record<string, string> = { titleFilter: title || q, locationFilter }
    if (f.experience)  p.experience  = f.experience
    if (f.jobType)     p.jobType     = f.jobType
    if (isRem)         p.remote      = 'true'
    if (f.datePosted && f.datePosted !== 'any') p.datePosted = f.datePosted
    return p
  }

  // Keep manual Search Jobs useful when paid credentials are absent or
  // exhausted. These public sources are a zero-cost safety net and the
  // provider router executes them before any paid source.
  const addFreeFallbacks = () => {
    const geo = country ? (JOBICY_GEO[country] ?? (isEU ? 'europe' : 'anywhere')) : isUS ? 'usa' : 'anywhere'
    if (!sources.some(source => source.id === 'jobicy')) {
      sources.push({ id: 'jobicy', params: { tag: title || q, geo } })
    }
    if (!sources.some(source => source.id === 'remotive')) {
      sources.push({ id: 'remotive', params: { q: title || q } })
    }
  }

  // Internship search → dedicated Internships API (free, specialized) takes priority
  if (isInternship) {
    sources.push({ id: 'internships', params: {
      q:          title || q,
      location:   loc,
      remote:     isRem ? '1' : '',
      datePosted: f.datePosted,
    }})
    // Pair with ATS for career-site intern roles not covered by Internships API
    if (sources.length < 3)
      sources.push({ id: 'ats', params: baseParams(loc || (isUS ? 'United States' : '')) })
    addCleanJobData()
    addFreeFallbacks()
    return {
      reasoning: `Internship Search → ${sources.map(s => s.id).join(' + ')}`,
      sources: sources.slice(0, (hasCleanJobData ? 4 : 3) + 2),
    }
  }

  // Helper: first keyword in EU_COUNTRY_MAP for a given country code
  const countryName = (code: string) => Object.entries(EU_COUNTRY_MAP).find(([, c]) => c === code)?.[0] ?? ''

  const xingParams = (): Record<string, string> => ({
    q:          title || q,
    location:   loc,
    experience: f.experience,
    jobType:    f.jobType,
    remote:     isRem ? '1' : '',
    datePosted: f.datePosted,
    ...(f.salaryMin ? { salaryMin: String(f.salaryMin / 1000) } : {}),
  })

  const adzunaParams = (code: string): Record<string, string> => {
    const p: Record<string, string> = { country: code, q: title || q }
    if (loc && !/^remote$/i.test(loc)) p.where = loc
    return p
  }

  const cjParams = (code: string): Record<string, string> => ({
    q:       title || q,
    location: loc || countryName(code),
    locale:   CAREERJET_LOCALE[code] ?? 'en_GB',
    country:  code,
  })

  // Company query (e.g. "jobs at stripe") → Mantiks company endpoint takes priority
  if (qa?.isCompanyQuery && hasMantiks) {
    const companyName = companyQueryName ?? ''
    sources.push({ id: 'mantiks', params: { q: companyName, datePosted: f.datePosted || 'month' } })
    sources.push({ id: 'linkedin', params: baseParams(loc || 'Worldwide') })
    sources.push({ id: 'ats', params: baseParams(loc || 'Worldwide') })
    addCleanJobData(companyName)
    addFreeFallbacks()
    return { reasoning: `Company search → ${sources.map(source => source.id).join(' + ')}`, sources }
  }

  // Remote: Jobicy (geo-filtered) + Remotive (tech-focused) + ATS
  if (isRem) {
    const geo = country ? (JOBICY_GEO[country] ?? 'europe') : isUS ? 'usa' : 'anywhere'
    sources.push({ id: 'jobicy', params: { tag: title || q, geo } })
    sources.push({ id: 'remotive', params: { q: title || q } })
    if (sources.length < 3)
      sources.push({ id: 'ats', params: baseParams(loc || (isUS ? 'United States' : '')) })
  }

  if (isEU) {
    if (DACH_COUNTRIES.has(country!)) {
      // DACH tier: Xing (local network + salary) + Bundesagentur (DE only) or Adzuna
      sources.push({ id: 'xing', params: xingParams() })
      if (country === 'de' && sources.length < 3) {
        const bp: Record<string, string> = { q: title || q }
        if (loc) bp.location = loc
        if (f.jobType) bp.jobType = f.jobType
        if (f.datePosted && f.datePosted !== 'any') bp.datePosted = f.datePosted
        sources.push({ id: 'bundesagentur', params: bp })
      }
      if (sources.length < 3)
        sources.push({ id: 'adzuna', params: adzunaParams(country!) })

    } else if (country === 'ie') {
      // ── Ireland — verified 5-source strategy ───────────────────────────────
      // NOTE: Adzuna does NOT support 'ie' country code (404) and GB+where=Ireland
      // returns only ~1 result. Adzuna is excluded from IE routing.
      //
      // Verified working sources for Ireland:
      //   LinkedIn(Ireland) ✅ | Indeed IE ✅ | ATS ✅ | Reed(key) ✅ | CareerJet(key) ✅
      //   JSearch(Ireland) ✅ | IrishJobs.ie RSS ⚠️ (blocked, best-effort)

      // 1. LinkedIn Ireland — Very strong; all Dublin tech multinationals use LinkedIn
      sources.push({ id: 'linkedin', params: {
        ...baseParams(loc || 'Ireland'),
        locationFilter: loc ? `${loc}, Ireland` : 'Ireland',
      }})

      // 2. Indeed IE — Direct Irish Indeed listings (verified with countryCode=ie)
      sources.push({ id: 'indeed', params: {
        q:           title || q,
        location:    loc || 'Ireland',
        countryCode: 'ie',
        sortType:    'date',
      }})

      // 3. ATS — Company career sites: Google IE, Meta IE, Stripe, HubSpot etc.
      sources.push({ id: 'ats', params: {
        ...baseParams(loc || 'Ireland'),
        locationFilter: loc || 'Ireland OR Dublin',
      }})

      // 4a. Reed (when key available) — Strong Irish employer listings
      if (hasReed) sources.push({ id: 'reed', params: { q: title || q, location: loc || 'Ireland' } })
      // 4b. CareerJet en_IE (when key available) — Aggregates Irish job boards
      else if (hasCareerjet) sources.push({ id: 'careerjet', params: cjParams('ie') })
      // 4c. JSearch fallback — Google Jobs: picks up IrishJobs, Jobs.ie, and others
      else sources.push({ id: 'jsearch', params: { query: (title || q) + ' in Ireland' } })

      // 5. IrishJobs.ie RSS (free, native — best-effort, may be rate-limited)
      sources.push({ id: 'irishjobs', params: { q: title || q, location: loc || 'ireland' } })

    } else if (country === 'gb') {
      // ── UK — Reed prioritized alongside Adzuna ─────────────────────────────
      sources.push({ id: 'adzuna', params: adzunaParams('gb') })
      if (hasReed) sources.push({ id: 'reed', params: { q: title || q, location: loc || 'United Kingdom' } })
      if (sources.length < 3) sources.push({ id: 'ats', params: baseParams(loc || 'United Kingdom') })

    } else if (ADZUNA_EU.has(country!)) {
      // Other Adzuna-tier EU: Adzuna + ATS
      sources.push({ id: 'adzuna', params: adzunaParams(country!) })
      if (sources.length < 3) sources.push({ id: 'ats', params: baseParams(loc || countryName(country!)) })

    } else if (CAREERJET_EU.has(country!)) {
      // Eastern EU: CareerJet (multi-country, key-gated) or JSearch fallback
      if (hasCareerjet)
        sources.push({ id: 'careerjet', params: cjParams(country!) })
      else
        sources.push({ id: 'jsearch', params: { query: q + (loc ? ` in ${loc}` : '') } })
      if (sources.length < 3) sources.push({ id: 'ats', params: baseParams(loc || countryName(country!)) })
    }

    // LinkedIn freshness fills remaining slot for all EU
    if (sources.length < 3)
      sources.push({ id: 'linkedin', params: baseParams(loc || countryName(country!)) })

  } else if (!isRem) {
    // US / global: Indeed + ATS + JSearch
    sources.push({ id: 'indeed', params: { q, location: loc, countryCode: isUS ? 'us' : 'gb', sortType: 'date' } })
    sources.push({ id: 'ats', params: baseParams(loc || (isUS ? 'United States' : 'United States OR United Kingdom')) })
    if (sources.length < 3)
      sources.push({ id: 'jsearch', params: { query: q + (loc ? ` in ${loc}` : ''), country: 'us' } })
    // Mantiks: multi-source + hiring manager contacts (optional, key-gated)
    if (hasMantiks && sources.length < 4)
      sources.push({ id: 'mantiks', params: { q: title || q, datePosted: f.datePosted || 'week' } })
  }

  // Guarantee minimum 2 sources
  if (sources.length < 2) sources.push({ id: 'ats', params: baseParams(loc) })
  addCleanJobData(companyQueryName)
  addFreeFallbacks()

  const names     = sources.map(s => s.id).join(' + ')
  const reasoning = isRem        ? `remote → ${names}`
                  : country === 'ie' ? `🇮🇪 Ireland → ${names}`
                  : isEU         ? `${country!.toUpperCase()} → ${names}`
                  : `worldwide/USA → ${names}`

  // Ireland gets up to 5 sources; others get 4
  const limit = (country === 'ie' ? 5 : 4) + (hasCleanJobData ? 1 : 0) + 2
  return { reasoning, sources: sources.slice(0, limit) }
}

// ── Source fetchers ───────────────────────────────────────────────────────────

async function fetchCleanJobDataSource(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const apiKey = filters.discovery?.cleanJobDataApiKey ?? ''
  if (!apiKey) return []
  const jobs = await fetchCleanJobData({
    apiKey,
    title: p.q ?? '',
    countryCode: p.country,
    companyName: p.companyName,
    remote: p.remote === 'true' || filters.remote,
    datePosted: p.datePosted || filters.datePosted,
    experience: p.experience || filters.experience,
    jobType: p.jobType || filters.jobType,
    salaryMin: p.salaryMin ? Number(p.salaryMin) : filters.salaryMin,
    salaryMax: p.salaryMax ? Number(p.salaryMax) : filters.salaryMax,
    maxPages: 1,
    maxResults: 20,
    userId: filters.usage?.userId,
  })
  return jobs.map(job => ({
    id: job.externalId,
    title: job.title,
    company: job.company,
    location: job.location,
    salary: job.salary ?? undefined,
    description: truncate(job.description),
    url: job.url,
    postedAt: job.postedAt,
    jobType: job.jobType,
    logo: job.logo,
    experienceLevel: job.experienceLevel,
    workArrangement: job.workArrangement,
    directApply: job.directApply,
    source: 'cleanjobdata' as const,
    score: 0,
  }))
}

async function fetchFantasticJobsSource(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const apiKey = filters.discovery?.fantasticJobsApiKey ?? ''
  if (!apiKey) return []
  const jobs = await fetchFantasticJobs({
    apiKey,
    title: p.title ?? p.q ?? cleanSearchTitle(p.query ?? ''),
    location: p.location ?? filters.location,
    datePosted: p.datePosted || filters.datePosted,
    userId: filters.usage?.userId,
  })
  return jobs.map(job => ({
    id: job.externalId,
    title: job.title,
    company: job.company,
    location: job.location,
    salary: job.salary ?? undefined,
    description: truncate(job.description),
    url: job.url,
    postedAt: job.postedAt,
    jobType: job.jobType,
    logo: job.logo,
    experienceLevel: job.experienceLevel,
    workArrangement: job.workArrangement,
    directApply: true,
    source: 'fantasticjobs' as const,
    score: 0,
  }))
}


async function fetchAdzuna(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const country = p.country || 'gb'
  const sym = { gb: '£', us: '$', ca: 'C$', au: 'A$' }[country] ?? '€'
  const appId = filters.discovery?.adzunaAppId ?? ''
  const appKey = filters.discovery?.adzunaAppKey ?? ''
  if (!appId || !appKey) return []
  const params = new URLSearchParams({
    app_id:           appId,
    app_key:          appKey,
    results_per_page: '15',
    sort_by:          'date',
    what:             p.q ?? p.query ?? '',
  })
  if (p.where)    params.set('where', p.where)
  if (filters.jobType === 'fulltime')  params.set('full_time', '1')
  if (filters.jobType === 'parttime')  params.set('part_time', '1')
  if (filters.jobType === 'contract')  params.set('contract', '1')
  if (filters.datePosted === 'today')  params.set('max_days_old', '1')
  if (filters.datePosted === 'week')   params.set('max_days_old', '7')
  if (filters.datePosted === 'month')  params.set('max_days_old', '30')

  const res = await trackedJobApiFetch(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`, { cache: 'no-store', redirect: 'error' }, usageMeta(filters, 'adzuna', 'search', filters.usage?.adzunaSource === 'user' ? 'user' : 'platform'))
  if (!res.ok) return []
  const json = await res.json() as { results: Array<{ id: string; title: string; company: { display_name: string }; location: { display_name: string }; salary_min?: number; salary_max?: number; redirect_url: string; description: string; created: string; contract_time?: string }> }
  return (json.results ?? []).map(r => ({
    id:          r.id,
    title:       r.title,
    company:     r.company?.display_name ?? '',
    location:    r.location?.display_name ?? '',
    salary:      fmtSalary(r.salary_min, r.salary_max, sym),
    description: truncate(r.description ?? ''),
    url:         r.redirect_url,
    postedAt:    r.created,
    jobType:     r.contract_time ?? null,
    source:      'adzuna' as const,
    score:       0,
  }))
}

async function fetchJSearch(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const apiKey = filters.discovery?.rapidapiKey ?? ''
  if (!apiKey) return []
  const params = new URLSearchParams({ query: p.query ?? '', num_pages: '1', country: p.country || 'us', date_posted: 'all' })
  if (p.employmentType || filters.jobType) {
    const map: Record<string, string> = { fulltime: 'FULLTIME', parttime: 'PARTTIME', contract: 'CONTRACTOR', internship: 'INTERN' }
    const t = map[p.employmentType ?? filters.jobType ?? '']
    if (t) params.set('employment_types', t)
  }
  if (p.remote === 'true' || filters.remote) params.set('remote_jobs_only', 'true')
  if (filters.datePosted === 'today') params.set('date_posted', 'today')
  if (filters.datePosted === 'week')  params.set('date_posted', 'week')

  const res = await trackedJobApiFetch(`https://jsearch.p.rapidapi.com/search-v2?${params}`, {
    headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
    cache: 'no-store',
  }, usageMeta(filters, 'rapidapi-jsearch', 'search', rapidSource(filters)))
  if (!res.ok) return []
  const json = await res.json() as { data?: { jobs?: Array<{ job_id: string; job_title: string; employer_name: string; job_city?: string; job_state?: string; job_country?: string; job_employment_type?: string; job_apply_link: string; job_description?: string; job_posted_at_datetime_utc?: string; job_min_salary?: number | null; job_max_salary?: number | null; job_salary_currency?: string | null; job_is_remote?: boolean }> } }
  return (json.data?.jobs ?? []).map(r => {
    const loc = [r.job_city, r.job_state, r.job_country].filter(Boolean).join(', ')
    return {
      id:          r.job_id,
      title:       r.job_title,
      company:     r.employer_name ?? '',
      location:    r.job_is_remote ? `Remote${loc ? ` · ${loc}` : ''}` : (loc || ''),
      salary:      fmtSalary(r.job_min_salary, r.job_max_salary, r.job_salary_currency === 'GBP' ? '£' : r.job_salary_currency === 'EUR' ? '€' : '$'),
      description: truncate(r.job_description ?? ''),
      url:         r.job_apply_link,
      postedAt:    r.job_posted_at_datetime_utc ?? null,
      jobType:     r.job_employment_type ?? null,
      source:      'jsearch' as const,
      score:       0,
    }
  })
}

const LI_HOST = 'linkedin-job-search-api.p.rapidapi.com'

const LI_SENIORITY: Record<string, string> = {
  entry:  'Entry level,Internship',
  mid:    'Associate,Mid-Senior level',
  senior: 'Mid-Senior level',
  lead:   'Director,Executive',
}
const LI_TYPE: Record<string, string> = {
  fulltime: 'FULL_TIME', parttime: 'PART_TIME',
  contract: 'CONTRACTOR', internship: 'INTERN',
}

function liDateFilter(preset: string): string | null {
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

// Coerces salary_raw (could be string or Google Jobs JSON object) into a display string
/** LinkedIn/ATS return partial logo paths — prepend CDN domain */
function fixLogo(logo?: string | null): string | null {
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

async function fetchLinkedIn(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const apiKey = filters.discovery?.rapidapiKey ?? ''
  if (!apiKey) return []
  const params = new URLSearchParams({
    offset:                '0',
    description_type:      'text',
    limit:                 '20',
    include_ai:            'true',
    exclude_ats_duplicate: 'true',
  })
  if (p.titleFilter)    params.set('title_filter', p.titleFilter)
  if (p.locationFilter) params.set('location_filter', p.locationFilter)

  const exp = p.experience || filters.experience
  if (LI_SENIORITY[exp]) params.set('seniority_filter', LI_SENIORITY[exp])

  const jt = p.jobType || filters.jobType
  if (LI_TYPE[jt]) params.set('type_filter', LI_TYPE[jt])

  if (p.remote === 'true' || filters.remote) params.set('remote', 'true')

  const dp = p.datePosted || filters.datePosted
  const threshold = liDateFilter(dp)
  if (threshold) params.set('date_filter', threshold)

  // Use 24h endpoint for broader coverage in unified search
  const res = await trackedJobApiFetch(`https://${LI_HOST}/active-jb-24h?${params}`, {
    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': LI_HOST },
    cache: 'no-store',
  }, usageMeta(filters, 'rapidapi-linkedin', 'search', rapidSource(filters)))
  if (!res.ok) return []
  const json = await res.json()
  if (!Array.isArray(json)) return []

  return json.map((r: {
    id: string; title: string; organization: string; organization_logo?: string | null
    locations_derived?: string[]; remote_derived?: boolean
    salary_raw?: string | null; employment_type?: string[]
    url: string; date_posted?: string; description_text?: string
    external_apply_url?: string | null; seniority?: string | null; directapply?: boolean
    ai_salary_currency?: string | null; ai_salary_minvalue?: number | null
    ai_salary_maxvalue?: number | null; ai_salary_unittext?: string | null
    ai_key_skills?: string[] | null; ai_work_arrangement?: string | null
    ai_experience_level?: string | null
  }) => {
    const salary = safeSalary(r.salary_raw)
      ?? fmtAiSalary(r.ai_salary_minvalue, r.ai_salary_maxvalue, r.ai_salary_currency, r.ai_salary_unittext)
    const loc = r.remote_derived
      ? `Remote${r.locations_derived?.[0] ? ` · ${r.locations_derived[0]}` : ''}`
      : (r.locations_derived?.[0] ?? '')
    return {
      id:              r.id,
      title:           r.title,
      company:         r.organization,
      logo:            fixLogo(r.organization_logo),
      location:        loc,
      salary,
      description:     truncate(r.description_text ?? ''),
      url:             r.external_apply_url || r.url,
      postedAt:        r.date_posted ?? null,
      jobType:         r.employment_type?.[0]?.replace('_', ' ') ?? null,
      seniority:       r.seniority ?? null,
      directApply:     r.directapply ?? false,
      keySkills:       r.ai_key_skills ?? [],
      workArrangement: r.ai_work_arrangement ?? null,
      experienceLevel: r.ai_experience_level ?? null,
      source:          'linkedin' as const,
      score:           0,
    }
  })
}

async function fetchJobicy(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const params = new URLSearchParams({ count: '20' })
  if (p.tag) params.set('tag', p.tag)
  if (p.geo) params.set('geo', p.geo)

  const res = await trackedJobApiFetch(`https://jobicy.com/api/v2/remote-jobs?${params}`, {
    headers: { 'User-Agent': 'ApplyMate/1.0' },
    cache: 'no-store',
  }, usageMeta(filters, 'jobicy', 'search'))
  if (!res.ok) return []
  const json = await res.json() as { jobs?: Array<{ id: number; url: string; jobTitle: string; companyName: string; jobType: string[]; jobGeo: string; jobExcerpt: string; pubDate: string; annualSalaryMin?: number; annualSalaryMax?: number; salaryCurrency?: string }> }
  return (json.jobs ?? []).map(r => ({
    id:          String(r.id),
    title:       r.jobTitle,
    company:     r.companyName,
    location:    r.jobGeo || 'Remote',
    salary:      r.annualSalaryMin ? fmtSalary(r.annualSalaryMin, r.annualSalaryMax, r.salaryCurrency === 'GBP' ? '£' : r.salaryCurrency === 'EUR' ? '€' : '$') : undefined,
    description: truncate(r.jobExcerpt ?? ''),
    url:         r.url,
    postedAt:    r.pubDate ?? null,
    jobType:     r.jobType?.[0] ?? null,
    source:      'jobicy' as const,
    score:       0,
  }))
}

const ATS_HOST = 'active-jobs-db.p.rapidapi.com'

const ATS_SENIORITY: Record<string, string> = {
  entry:  'Entry level,Internship',
  mid:    'Associate,Mid-Senior level',
  senior: 'Mid-Senior level',
  lead:   'Director,Executive',
}
const ATS_TYPE: Record<string, string> = {
  fulltime: 'FULL_TIME', parttime: 'PART_TIME',
  contract: 'CONTRACTOR', internship: 'INTERN',
}

async function fetchAts(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const apiKey = filters.discovery?.rapidapiKey ?? ''
  if (!apiKey) return []
  const params = new URLSearchParams({
    offset:           '0',
    description_type: 'text',
    limit:            '20',
    include_ai:       'true',
  })
  if (p.titleFilter)    params.set('title_filter', p.titleFilter)
  if (p.locationFilter) params.set('location_filter', p.locationFilter)

  const exp = p.experience || filters.experience
  if (ATS_SENIORITY[exp]) params.set('seniority_filter', ATS_SENIORITY[exp])

  const jt = p.jobType || filters.jobType
  if (ATS_TYPE[jt]) params.set('type_filter', ATS_TYPE[jt])

  if (p.remote === 'true' || filters.remote) params.set('remote', 'true')

  const dp = p.datePosted || filters.datePosted
  if (dp && dp !== 'any') {
    const days: Record<string, number> = { today: 1, week: 7, month: 30 }
    const d = days[dp]
    if (d) params.set('date_filter', new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10))
  }

  const res = await trackedJobApiFetch(`https://${ATS_HOST}/active-ats-7d?${params}`, {
    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': ATS_HOST },
    cache: 'no-store',
  }, usageMeta(filters, 'rapidapi-active-jobs', 'search', rapidSource(filters)))
  if (!res.ok) return []
  const json = await res.json()
  if (!Array.isArray(json)) return []

  return json.map((r: {
    id: string; title: string; organization: string; organization_logo?: string | null
    locations_derived?: string[]; remote_derived?: boolean
    url: string; apply_url?: string | null
    date_posted?: string; description_text?: string
    employment_type?: string[]; seniority?: string | null
    ai_salary_currency?: string | null; ai_salary_minvalue?: number | null
    ai_salary_maxvalue?: number | null; ai_salary_unittext?: string | null
    ai_key_skills?: string[] | null; ai_work_arrangement?: string | null
    ai_experience_level?: string | null
  }) => {
    const salary = fmtAiSalary(
      r.ai_salary_minvalue, r.ai_salary_maxvalue,
      r.ai_salary_currency, r.ai_salary_unittext,
    )
    const loc = r.remote_derived
      ? `Remote${r.locations_derived?.[0] ? ` · ${r.locations_derived[0]}` : ''}`
      : (r.locations_derived?.[0] ?? '')
    return {
      id:              r.id,
      title:           r.title,
      company:         r.organization,
      logo:            fixLogo(r.organization_logo),
      location:        loc,
      salary,
      description:     truncate(r.description_text ?? ''),
      url:             r.apply_url || r.url,
      postedAt:        r.date_posted ?? null,
      jobType:         r.employment_type?.[0]?.replace('_', ' ') ?? null,
      seniority:       r.seniority ?? null,
      directApply:     true,
      keySkills:       r.ai_key_skills ?? [],
      workArrangement: r.ai_work_arrangement ?? null,
      experienceLevel: r.ai_experience_level ?? null,
      source:          'ats' as const,
      score:           0,
    }
  })
}

const JOBS_API_HOST = 'jobs-api14.p.rapidapi.com'

// Xing career level + type maps (same as standalone route)
const XING_CAREER: Record<string, string> = {
  entry: 'student;entry', mid: 'professional',
  senior: 'professional;manager', lead: 'manager;executive;seniorExecutive',
}
const XING_TYPE: Record<string, string> = {
  fulltime: 'fulltime', parttime: 'parttime', contract: 'contractor', internship: 'intern',
}
const XING_DATE: Record<string, string> = { today: 'day', week: 'week', month: 'month' }

async function fetchXing(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const apiKey = filters.discovery?.rapidapiKey ?? ''
  if (!apiKey) return []
  const params = new URLSearchParams()
  const q   = p.q || p.titleFilter || ''
  const loc = p.location || p.locationFilter || filters.location || ''
  if (!q) return []
  params.set('query', q)
  if (loc) params.set('location', loc)

  const exp  = p.experience || filters.experience
  const jt   = p.jobType    || filters.jobType
  const dp   = p.datePosted || filters.datePosted
  const isRm = p.remote === '1' || p.remote === 'true' || filters.remote
  const salaryMin = p.salaryMin ? Number(p.salaryMin) * 1000 : filters.salaryMin

  if (XING_CAREER[exp])  params.set('careerLevels', XING_CAREER[exp])
  if (XING_TYPE[jt])     params.set('employmentTypes', XING_TYPE[jt])
  if (XING_DATE[dp])     params.set('datePosted', XING_DATE[dp])
  if (isRm)              params.set('remoteOptions', 'remote;hybrid')
  if (salaryMin && salaryMin > 0) params.set('minimumSalary', String(salaryMin))

  const res = await trackedJobApiFetch(`https://${JOBS_API_HOST}/v2/xing/search?${params}`, {
    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': JOBS_API_HOST },
    cache: 'no-store',
  }, usageMeta(filters, 'rapidapi-jobs-api14', 'xing_search', rapidSource(filters)))
  if (!res.ok) return []
  const json = await res.json() as {
    data?: Array<{
      id: string; title: string; company: string; location?: string
      employmentType?: string; dateUpdated?: string; image?: string
      salary?: { currency: string; minimum?: number; maximum?: number } | null
    }>
    hasError?: boolean
  }
  if (json.hasError || !Array.isArray(json.data)) return []

  return json.data.map(r => {
    let salary: string | undefined
    if (r.salary?.minimum || r.salary?.maximum) {
      const sym = r.salary.currency === 'CHF' ? 'CHF ' : r.salary.currency === 'EUR' ? '€ ' : (r.salary.currency + ' ')
      const min = r.salary.minimum, max = r.salary.maximum
      salary = (min && max && min !== max) ? `${sym}${min.toLocaleString()}–${max.toLocaleString()}/yr`
             : min ? `${sym}${min.toLocaleString()}/yr`
             : max ? `${sym}${max.toLocaleString()}/yr` : undefined
    }
    return {
      id:          r.id,
      title:       r.title,
      company:     r.company,
      logo:        r.image || null,
      location:    r.location ?? '',
      salary,
      // Xing search doesn't return individual job URLs; link to a contextual search
      description: '',
      url:         `https://www.xing.com/jobs/search?q=${encodeURIComponent(r.title)}&l=${encodeURIComponent(r.location ?? '')}`,
      postedAt:    r.dateUpdated ?? null,
      jobType:     r.employmentType ?? null,
      source:      'xing' as const,
      score:       0,
    }
  })
}

async function fetchIndeed(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const apiKey = filters.discovery?.rapidapiKey ?? ''
  if (!apiKey) return []
  const q           = p.q || p.titleFilter || ''
  const loc         = p.location || p.locationFilter || ''
  const countryCode = p.countryCode || 'us'
  if (!q) return []

  const params = new URLSearchParams({ query: q, countryCode, sortType: 'date' })
  if (loc) params.set('location', loc)

  const res = await trackedJobApiFetch(`https://${JOBS_API_HOST}/v2/indeed/search?${params}`, {
    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': JOBS_API_HOST },
    cache: 'no-store',
  }, usageMeta(filters, 'rapidapi-jobs-api14', 'indeed_search', rapidSource(filters)))
  if (!res.ok) return []
  const json = await res.json() as {
    data?: Array<{
      id: string; title: string
      company: { name: string; image?: string }
      location: { location?: string; country?: string }
      description?: string; applyUrl?: string
    }>
    hasError?: boolean
  }
  if (json.hasError || !Array.isArray(json.data)) return []

  return json.data.map(r => ({
    id:          r.id,
    title:       r.title,
    company:     r.company?.name ?? '',
    logo:        r.company?.image || null,
    location:    r.location?.location ?? r.location?.country ?? '',
    salary:      undefined,
    description: truncate(r.description ?? ''),
    url:         r.applyUrl ?? '',
    postedAt:    null,
    jobType:     null,
    source:      'indeed' as const,
    score:       0,
  }))
}

async function fetchRemotive(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const q = p.q || p.titleFilter || ''
  const params = new URLSearchParams({ limit: '20' })
  if (q) params.set('search', q)

  const res = await trackedJobApiFetch(`https://remotive.com/api/remote-jobs?${params}`, {
    headers: { 'User-Agent': 'ApplyMate/1.0' },
    next: { revalidate: 900 },
  }, usageMeta(filters, 'remotive', 'search'))
  if (!res.ok) return []
  const json = await res.json() as {
    jobs?: Array<{
      id: number; url: string; title: string; company_name: string; company_logo: string
      job_type: string; publication_date: string; candidate_required_location: string
      salary: string; description: string
    }>
  }
  const JT: Record<string, string> = { full_time: 'Full Time', contract: 'Contract', part_time: 'Part Time', freelance: 'Freelance' }
  return (json.jobs ?? []).map(r => ({
    id:          String(r.id),
    title:       r.title,
    company:     r.company_name,
    logo:        r.company_logo || null,
    location:    r.candidate_required_location || 'Remote',
    salary:      r.salary || undefined,
    description: truncate(r.description?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') ?? ''),
    url:         r.url,
    postedAt:    r.publication_date ?? null,
    jobType:     JT[r.job_type] ?? r.job_type ?? null,
    source:      'remotive' as const,
    score:       0,
  }))
}

async function fetchBundesagentur(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const q   = p.q || p.titleFilter || ''
  const loc = p.location || p.locationFilter || filters.location || ''
  if (!q && !loc) return []

  const AT_MAP: Record<string, string> = { fulltime: 'VOLLZEIT', parttime: 'TEILZEIT', remote: 'HOMEOFFICE' }
  const DT_MAP: Record<string, string> = { today: '1', week: '7', month: '30' }
  const params = new URLSearchParams({ size: '20', page: '0' })
  if (q)   params.set('was', q)
  if (loc) params.set('wo', loc)
  const at = AT_MAP[p.jobType || filters.jobType || '']
  if (at) params.set('arbeitszeit', at)
  const dt = DT_MAP[p.datePosted || filters.datePosted || '']
  if (dt) params.set('veroeffentlichtseit', dt)

  const res = await trackedJobApiFetch(`https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?${params}`, {
    headers: { 'X-API-Key': 'jobboerse-jobsuche' },
    cache: 'no-store',
  }, usageMeta(filters, 'bundesagentur', 'search'))
  if (!res.ok) return []
  const json = await res.json() as {
    stellenangebote?: Array<{
      refnr: string; titel: string; arbeitgeber: string
      arbeitsort?: { ort?: string; region?: string }
      veroeffentlichungsdatum?: string; logoUrl?: string
      arbeitszeit?: string | string[]
    }>
  }
  return (json.stellenangebote ?? []).map(r => {
    const jts    = Array.isArray(r.arbeitszeit) ? r.arbeitszeit : r.arbeitszeit ? [r.arbeitszeit] : []
    const isHome = jts.includes('HOMEOFFICE')
    const locStr = [r.arbeitsort?.ort, r.arbeitsort?.region].filter(Boolean).join(', ')
    return {
      id:          r.refnr,
      title:       r.titel,
      company:     r.arbeitgeber,
      logo:        r.logoUrl || null,
      location:    isHome ? `Remote · ${locStr}`.replace(/ · $/, '') : locStr,
      salary:      undefined,
      description: '',
      url:         `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(r.refnr)}`,
      postedAt:    r.veroeffentlichungsdatum ?? null,
      jobType:     jts.includes('VOLLZEIT') ? 'Full Time' : jts.includes('TEILZEIT') ? 'Part Time' : null,
      source:      'bundesagentur' as const,
      score:       0,
    }
  })
}

async function fetchCareerjet(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const affid = process.env.CAREERJET_AFFID
  if (!affid) return []
  const q   = p.q || p.titleFilter || ''
  const loc = p.location || p.locationFilter || ''
  if (!q && !loc) return []

  const params = new URLSearchParams({
    affid, locale: p.locale || 'en_GB', sort: 'date',
    pagesize: '20', page: '1',
    user_agent: 'ApplyMate/1.0',
  })
  if (filters.usage?.clientIp) params.set('user_ip', filters.usage.clientIp)
  if (q)   params.set('keywords', q)
  if (loc) params.set('location', loc)

  const res = await trackedJobApiFetch(`https://search.api.careerjet.net/v4/query?${params}`, { cache: 'no-store', redirect: 'error' }, usageMeta(filters, 'careerjet', 'search', 'platform'))
  if (!res.ok) return []
  const json = await res.json() as {
    type?: string; jobs?: Array<{
      title: string; locations: string; company: string
      url: string; date: string; description: string; salary?: string
    }>
  }
  if (json.type === 'error') return []
  return (json.jobs ?? []).map((r, i) => ({
    id:          `cj-${i}`,
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
    score:       0,
  }))
}

// Reed requires REED_API_KEY env var — skip gracefully if not configured
async function fetchReed(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const reedKey = process.env.REED_API_KEY
  if (!reedKey) return []
  const q   = p.q || p.titleFilter || ''
  const loc = p.location || p.locationFilter || filters.location || ''
  const credentials = Buffer.from(`${reedKey}:`).toString('base64')
  const params = new URLSearchParams({ resultsToTake: '20', resultsToSkip: '0' })
  if (q)   params.set('keywords', q)
  if (loc) params.set('locationName', loc)
  if (filters.jobType === 'fulltime')   params.set('fullTime', 'true')
  else if (filters.jobType === 'parttime')  params.set('partTime', 'true')
  else if (filters.jobType === 'contract')  params.set('contract', 'true')

  const res = await trackedJobApiFetch(`https://www.reed.co.uk/api/1.0/search?${params}`, {
    headers: { Authorization: `Basic ${credentials}` },
    cache: 'no-store',
  }, usageMeta(filters, 'reed', 'search', 'platform'))
  if (!res.ok) return []
  const json = await res.json() as {
    results?: Array<{
      jobId: number; employerName: string; jobTitle: string; locationName: string
      minimumSalary?: number; maximumSalary?: number; jobUrl: string
      jobDescription: string; date: string; contractTime?: string
    }>
  }
  return (json.results ?? []).map(r => {
    const min = r.minimumSalary, max = r.maximumSalary
    const salary = (min || max)
      ? `£${min ? min.toLocaleString() : '?'}${max && max !== min ? `–${max.toLocaleString()}` : ''}/yr`
      : undefined
    return {
      id:          String(r.jobId),
      title:       r.jobTitle,
      company:     r.employerName,
      logo:        null,
      location:    r.locationName,
      salary,
      description: truncate(r.jobDescription ?? ''),
      url:         r.jobUrl,
      postedAt:    r.date ?? null,
      jobType:     r.contractTime ?? null,
      source:      'reed' as const,
      score:       0,
    }
  })
}

// IrishJobs.ie — free RSS feed (Ireland's #1 native job board)
function slugifyIE(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
}
function extractRssTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
           ?? xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'))
  return m?.[1]?.trim() ?? ''
}
function stripHtmlIE(h: string): string {
  return h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim()
}

async function fetchIrishjobs(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const q   = p.q || p.titleFilter || ''
  const loc = p.location || p.locationFilter || 'ireland'
  if (!q) return []

  const keySlug = slugifyIE(q)
  const locSlug = slugifyIE(loc)
  const urls = [
    `https://www.irishjobs.ie/jobs/${keySlug}/in-${locSlug}?format=rss`,
    `https://www.irishjobs.ie/jobs/${keySlug}?format=rss`,
  ]

  let xml = ''
  for (const url of urls) {
    try {
      const r = await trackedJobApiFetch(url, {
        headers: { 'User-Agent': 'ApplyMate/1.0', 'Accept': 'application/rss+xml, text/xml' },
        signal:  AbortSignal.timeout(7_000),
        cache:   'no-store',
      }, usageMeta(filters, 'irishjobs', 'rss_search'))
      if (r.ok) {
        const t = await r.text()
        if (t.includes('<item')) { xml = t; break }
      }
    } catch { continue }
  }
  if (!xml) return []

  const items = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)]
  return items.map((m, i) => {
    const item   = m[1]
    const title  = stripHtmlIE(extractRssTag(item, 'title'))
    const link   = extractRssTag(item, 'link')
    const desc   = stripHtmlIE(extractRssTag(item, 'description'))
    const pub    = extractRssTag(item, 'pubDate')
    const co     = desc.match(/Company[:\s]+([^|<\n]+)/i)?.[1]?.trim() ?? ''
    const locStr = desc.match(/Location[:\s]+([^|<\n]+)/i)?.[1]?.trim() ?? loc
    return {
      id:          `ij-${i}`,
      title,
      company:     co,
      location:    locStr,
      salary:      desc.match(/Salary[:\s]+([^|<\n]+)/i)?.[1]?.trim() ?? undefined,
      description: truncate(desc),
      url:         link,
      postedAt:    pub ? new Date(pub).toISOString() : null,
      jobType:     null,
      source:      'irishjobs' as const,
      score:       0,
    }
  })
}

async function fetchMantiks(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const apiKey = process.env.MANTIKS_API_KEY
  if (!apiKey) return []

  const q         = p.q || p.titleFilter || ''
  const datePosted = p.datePosted || filters.datePosted
  if (!q) return []

  const ageMap: Record<string, number> = { today: 1, week: 7, month: 30 }
  const age = ageMap[datePosted] ?? 7

  const params = new URLSearchParams({ job_age_in_days: String(age) })
  params.append('job_title', q)

  const res = await trackedJobApiFetch(`https://api.mantiks.io/company/search?${params}`, {
    headers: { 'X-API-KEY': apiKey },
    cache: 'no-store',
  }, usageMeta(filters, 'mantiks', 'company_search', 'platform'))
  if (!res.ok) return []

  const companies = await res.json() as Array<{
    company_name: string
    jobs: Array<{
      title: string; location?: string; posted_at?: string; date_creation?: string
      job_board?: string; job_board_url?: string; url?: string; description?: string
      contact?: { name?: string; job_title?: string; linkedin_url?: string; email?: string; phone?: string }
    }>
  }>
  if (!Array.isArray(companies)) return []

  const results: JobResult[] = []
  for (const company of companies.slice(0, 10)) {
    for (let i = 0; i < (company.jobs ?? []).length; i++) {
      const j  = company.jobs[i]
      const hm = j.contact?.name ? {
        name:        j.contact.name,
        title:       j.contact.job_title ?? '',
        linkedinUrl: j.contact.linkedin_url ?? '',
        email:       j.contact.email ?? null,
        phone:       j.contact.phone ?? null,
      } : null

      results.push({
        id:             `mantiks-${company.company_name}-${i}`,
        title:          j.title,
        company:        company.company_name,
        location:       j.location ?? '',
        salary:         undefined,
        description:    truncate(j.description ?? ''),
        url:            j.job_board_url ?? j.url ?? '',
        postedAt:       j.posted_at ?? j.date_creation ?? null,
        jobType:        null,
        hiringManager:  hm,
        source:         'mantiks',
        score:          0,
      })
    }
  }
  return results
}

const INTERNSHIPS_HOST = 'internships-api.p.rapidapi.com'

async function fetchInternships(p: Record<string, string>, filters: SearchFilters): Promise<JobResult[]> {
  const apiKey = filters.discovery?.rapidapiKey ?? ''
  if (!apiKey) return []
  const params = new URLSearchParams({
    offset:           '0',
    description_type: 'text',
    include_ai:       'true',
  })
  // q/location come directly (not titleFilter/locationFilter) since smartRouter sets them that way
  const q   = p.q || p.titleFilter || ''
  const loc = p.location || p.locationFilter || filters.location || ''
  if (q)   params.set('title_filter', q)
  if (loc) params.set('location_filter', loc)
  if (p.remote === '1' || p.remote === 'true' || filters.remote) params.set('remote', 'true')

  const dp = p.datePosted || filters.datePosted
  if (dp && dp !== 'any') {
    const days: Record<string, number> = { today: 1, week: 7, month: 30 }
    const d = days[dp]
    if (d) params.set('date_filter', new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10))
  }

  const res = await trackedJobApiFetch(`https://${INTERNSHIPS_HOST}/active-jb-7d?${params}`, {
    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': INTERNSHIPS_HOST },
    cache: 'no-store',
  }, usageMeta(filters, 'rapidapi-internships', 'search', rapidSource(filters)))
  if (!res.ok) return []
  const json = await res.json()
  if (!Array.isArray(json)) return []

  return json.map((r: {
    id: string; title: string; organization: string; organization_logo?: string | null
    locations_derived?: string[]; remote_derived?: boolean
    url: string; date_posted?: string; description_text?: string
    source_type?: string
    ai_salary_currency?: string | null; ai_salary_minvalue?: number | null
    ai_salary_maxvalue?: number | null; ai_salary_unittext?: string | null
  }) => {
    const salary = fmtAiSalary(
      r.ai_salary_minvalue, r.ai_salary_maxvalue,
      r.ai_salary_currency, r.ai_salary_unittext,
    )
    const loc = r.remote_derived
      ? `Remote${r.locations_derived?.[0] ? ` · ${r.locations_derived[0]}` : ''}`
      : (r.locations_derived?.[0] ?? '')
    return {
      id:          r.id,
      title:       r.title,
      company:     r.organization,
      logo:        fixLogo(r.organization_logo),
      location:    loc,
      salary,
      description: truncate(r.description_text ?? ''),
      url:         r.url,
      postedAt:    r.date_posted ?? null,
      jobType:     'Internship',
      directApply: r.source_type === 'ats' || r.source_type === 'career-site',
      source:      'internships' as const,
      score:       0,
    }
  })
}

// ── Relevance scoring ─────────────────────────────────────────────────────────

function scoreJobs(jobs: JobResult[], q: string, f: SearchFilters): JobResult[] {
  const ql       = q.toLowerCase()
  const words    = queryKeywords(ql)
  const isRemote = f.remote || /\b(remote|wfh|distributed)\b/.test(ql)

  const EXP_PATTERNS: Record<string, RegExp> = {
    entry:  /\b(junior|entry|graduate|intern|fresher)\b/i,
    mid:    /\b(mid|intermediate|ii|level 2)\b/i,
    senior: /\b(senior|sr\.?|staff|principal|iii|level 3)\b/i,
    lead:   /\b(lead|manager|head|director|vp|principal)\b/i,
  }

  return jobs.map(j => {
    let s = 0
    const titleL = j.title.toLowerCase()
    const descL  = j.description.toLowerCase().slice(0, 300)

    // ── Title keyword match (weighted) ──────────────────────────────────────
    const titleMatches = words.filter(w => titleL.includes(w)).length
    s += titleMatches * 3
    if (titleL.includes(ql)) s += 5   // exact phrase

    // ── Description keyword match (smaller weight) ───────────────────────────
    if (j.description) {
      s += 2  // has description bonus
      const descMatches = words.filter(w => descL.includes(w)).length
      s += Math.min(descMatches, 3)  // cap at 3 to avoid over-weighting
    }

    // ── AI key skills match ──────────────────────────────────────────────────
    if (j.keySkills?.length) {
      const skillMatches = j.keySkills.filter(sk =>
        words.some(w => sk.toLowerCase().includes(w))
      ).length
      s += Math.min(skillMatches * 2, 6)
    }

    // ── Work arrangement (remote intent) ────────────────────────────────────
    if (isRemote) {
      if (j.workArrangement === 'Remote Solely' || j.workArrangement === 'Remote OK') s += 3
      else if (j.workArrangement === 'Hybrid') s += 1
    }

    // ── Recency ──────────────────────────────────────────────────────────────
    if (j.postedAt) {
      const days = (Date.now() - new Date(j.postedAt).getTime()) / 86_400_000
      if      (days < 1)  s += 5
      else if (days < 3)  s += 4
      else if (days < 7)  s += 3
      else if (days < 14) s += 2
      else if (days < 30) s += 1
    }

    // ── Data completeness ────────────────────────────────────────────────────
    if (j.salary)           s += 1
    if (j.hiringManager)    s += 4   // contact available = high actionability
    if (j.logo)             s += 0   // cosmetic, no score impact

    // ── Experience level match ───────────────────────────────────────────────
    if (f.experience && EXP_PATTERNS[f.experience]?.test(j.title)) s += 4

    // ── Source quality ───────────────────────────────────────────────────────
    if (j.source === 'linkedin')     s += 2   // freshness (24h feed)
    if (j.directApply)               s += 3   // direct employer apply
    if (j.source === 'xing' && j.salary) s += 2   // native salary
    if (j.source === 'bundesagentur') s += 2  // official DE authority
    if (j.source === 'remotive')      s += 1  // curated remote-only
    if (j.source === 'irishjobs')     s += 3  // native Irish job board — high IE relevance
    if (j.source === 'indeed')        s += 1  // broad market coverage

    // ── Location relevance ───────────────────────────────────────────────────
    if (f.location) {
      const filterLocL = f.location.toLowerCase()
      const jobLocL    = j.location.toLowerCase()
      if (jobLocL.includes(filterLocL)) {
        s += 6  // exact city match in location field
      } else {
        // Check if this job's location clearly belongs to a different region
        // Only penalise when location data is present and clearly mismatches
        const isRemoteJob = j.workArrangement === 'Remote Solely' || j.workArrangement === 'Remote OK'
          || /\b(remote|anywhere|worldwide)\b/i.test(j.location)
        if (!isRemoteJob && j.location && j.location.length > 3) {
          s -= 3  // deprioritise jobs in other regions when user specified a location
        }
      }
    }

    return { ...j, score: s }
  })
}

// ── Metadata helpers ──────────────────────────────────────────────────────────

function buildSourceBreakdown(jobs: JobResult[]): Record<string, number> {
  const bd: Record<string, number> = {}
  for (const j of jobs) bd[j.source] = (bd[j.source] ?? 0) + 1
  return bd
}

function aggregateTopSkills(jobs: JobResult[], n = 10): string[] {
  const counts = new Map<string, number>()
  for (const j of jobs) {
    for (const sk of j.keySkills ?? []) {
      const k = sk.toLowerCase()
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([sk]) => sk)
}

// Salary market context — fires in parallel with job search, best-effort
async function fetchSalaryCtx(
  jobTitle: string,
  countryCode: string,
  apiKey: string,
  filters: SearchFilters,
): Promise<{ currency: string; median: number; min: number; max: number } | null> {
  if (!apiKey || !jobTitle) return null
  try {
    const clean  = jobTitle.replace(/\b(senior|sr|junior|jr|lead|staff|principal)\b/gi, '').trim()
    const params = new URLSearchParams({ query: clean, countryCode: countryCode || 'us' })
    const res = await trackedJobApiFetch(`https://jobs-api14.p.rapidapi.com/v2/salary/range?${params}`, {
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'jobs-api14.p.rapidapi.com' },
      next: { revalidate: 3600 },  // cache salary data 1 hr
    }, usageMeta(filters, 'rapidapi-jobs-api14', 'salary_range', rapidSource(filters)))
    if (!res.ok) return null
    const json = await res.json() as {
      data?: { currency?: string; yearlySalary?: { min: number; max: number; median: number } }
    }
    const d = json.data
    if (!d?.yearlySalary?.median) return null
    return {
      currency: d.currency ?? 'USD',
      median:   Math.round(d.yearlySalary.median),
      min:      Math.round(d.yearlySalary.min),
      max:      Math.round(d.yearlySalary.max),
    }
  } catch { return null }
}

// Smart fallback: if primary sources returned too few results, try LinkedIn globally
async function tryFallback(
  existing: JobResult[],
  q: string,
  filters: SearchFilters,
): Promise<JobResult[]> {
  if (existing.length >= MIN_RESULTS_FOR_FALLBACK) return []
  const fallbackParams = { titleFilter: q, locationFilter: filters.location }
  return withTimeout(fetchLinkedIn(fallbackParams, filters), SOURCE_TIMEOUT_MS, [])
}

// ── Route ─────────────────────────────────────────────────────────────────────

const FETCHERS: Record<string, (p: Record<string, string>, f: SearchFilters) => Promise<JobResult[]>> = {
  adzuna:        fetchAdzuna,
  jsearch:       fetchJSearch,
  linkedin:      fetchLinkedIn,
  jobicy:        fetchJobicy,
  ats:           fetchAts,
  internships:   fetchInternships,
  xing:          fetchXing,
  indeed:        fetchIndeed,
  remotive:      fetchRemotive,
  bundesagentur: fetchBundesagentur,
  careerjet:     fetchCareerjet,
  reed:          fetchReed,
  mantiks:       fetchMantiks,
  irishjobs:     fetchIrishjobs,
  cleanjobdata:  fetchCleanJobDataSource,
  fantasticjobs: fetchFantasticJobsSource,
}

const FREE_PROVIDER_IDS = ['bundesagentur', 'irishjobs', 'jobicy', 'remotive'] as const
const RAPID_PROVIDER_IDS = ['ats', 'careerjet', 'indeed', 'internships', 'jsearch', 'linkedin', 'mantiks', 'reed', 'xing'] as const

function providerCredentialSource(provider: string, filters: SearchFilters): ApiCredentialSource {
  if (provider === 'cleanjobdata' || provider === 'fantasticjobs' || provider === 'reed' || provider === 'careerjet' || provider === 'mantiks') return 'platform'
  if (provider === 'adzuna') return filters.usage?.adzunaSource === 'user' ? 'user' : 'platform'
  if (FREE_PROVIDER_IDS.includes(provider as typeof FREE_PROVIDER_IDS[number])) return 'public'
  return rapidSource(filters)
}

function availableProviders(filters: SearchFilters): Set<string> {
  const available = new Set<string>(FREE_PROVIDER_IDS)
  const discovery = filters.discovery
  if (discovery?.cleanJobDataApiKey) available.add('cleanjobdata')
  if (discovery?.fantasticJobsApiKey) available.add('fantasticjobs')
  if (discovery?.adzunaAppId && discovery.adzunaAppKey) available.add('adzuna')
  if (discovery?.rapidapiKey) for (const provider of RAPID_PROVIDER_IDS) available.add(provider)
  if (process.env.REED_API_KEY) available.add('reed')
  if (process.env.CAREERJET_AFFID) available.add('careerjet')
  if (process.env.MANTIKS_API_KEY) available.add('mantiks')
  return available
}

function cacheProviderScopes(calls: readonly SourceCall[], filters: SearchFilters): Record<string, 'platform' | 'user' | 'public'> {
  return Object.fromEntries(calls.map(call => [call.id, providerCredentialSource(call.id, filters)]))
}

async function executeSearchProviders(
  calls: readonly SourceCall[],
  filters: SearchFilters,
  shadowEnabled: boolean,
  shadowParams: Record<string, string>,
): Promise<{ items: JobResult[]; decisions: Awaited<ReturnType<typeof executeProviderPlan<JobResult>>>['decisions']; shadowItems: JobResult[]; shadowDecisions: Awaited<ReturnType<typeof executeProviderPlan<JobResult>>>['decisions'] }> {
  const uniqueCalls = [...new Map(calls.map(call => [
    `${call.id}|${Object.entries(call.params).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&')}`,
    call,
  ])).values()]
  const available = availableProviders(filters)
  const providerIds = [...new Set(uniqueCalls.map(call => call.id).concat(shadowEnabled ? ['fantasticjobs'] : []))]
  const scopeGroups = new Map<'platform' | 'user' | 'public', string[]>([['platform', []], ['user', []], ['public', []]])
  for (const provider of providerIds) scopeGroups.get(providerCredentialSource(provider, filters))?.push(provider)
  const stateEntries = await Promise.all([...scopeGroups.entries()].map(async ([scope, ids]) => [scope, await loadProviderStates(ids, scope)] as const))
  const states = new Map(stateEntries.flatMap(([, values]) => [...values.entries()]))
  const execute = (call: ProviderCall) => {
    const fetcher = FETCHERS[call.id]
    return fetcher ? withTimeout(fetcher(call.params, filters), SOURCE_TIMEOUT_MS, [] as JobResult[]) : Promise.resolve([] as JobResult[])
  }
  const reserve = (call: ProviderCall) => reserveProviderQuota({
    provider: call.id,
    operation: 'list',
    credentialSource: providerCredentialSource(call.id, filters),
    expectedJobs: 20,
  })
  const visible = await executeProviderPlan({
    calls: uniqueCalls.map(call => ({ ...call, expectedJobs: 20 })),
    availableProviders: available,
    states,
    targetResults: MIN_RESULTS_FOR_FALLBACK,
    execute,
    count: items => items.length,
    reserve,
  })
  if (!shadowEnabled || !filters.discovery?.fantasticJobsApiKey) return { items: visible.items, decisions: visible.decisions, shadowItems: [], shadowDecisions: [] }
  const shadow = await executeProviderPlan({
    calls: [{ id: 'fantasticjobs', params: shadowParams, expectedJobs: 20 }],
    availableProviders: available,
    states,
    targetResults: Number.MAX_SAFE_INTEGER,
    execute,
    count: items => items.length,
    reserve,
  })
  return { items: visible.items, decisions: visible.decisions, shadowItems: shadow.items, shadowDecisions: shadow.decisions }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'job_discovery')
  if (isErrorResponse(auth)) return auth

  const access = await getDiscoveryApiAccess(auth.userId)
  const discovery = {
    rapidapiKey: access.rapidapiKey,
    adzunaAppId: access.adzunaAppId,
    adzunaAppKey: access.adzunaAppKey,
    cleanJobDataApiKey: access.cleanJobDataApiKey,
    fantasticJobsApiKey: access.fantasticJobsApiKey,
  }

  const sp      = req.nextUrl.searchParams
  const q       = sp.get('q')?.trim() ?? ''
  const noCache = sp.get('noCache') === '1'
  if (!q) return err('q is required')

  const filters: SearchFilters = {
    location:   sp.get('location')?.trim() ?? '',
    remote:     sp.get('remote') === '1',
    jobType:    sp.get('jobType') ?? '',
    datePosted: sp.get('datePosted') ?? 'any',
    experience: sp.get('experience') ?? '',
    salaryMin:  sp.get('salaryMin') ? Number(sp.get('salaryMin')) * 1000 : undefined,
    salaryMax:  sp.get('salaryMax') ? Number(sp.get('salaryMax')) * 1000 : undefined,
    discovery,
    usage: { userId: auth.userId, rapidapiSource: access.rapidapiSource, adzunaSource: access.adzunaSource, clientIp: getClientIp(req.headers) },
  }

  // ① Analyze intent and build a credential-scoped cache identity before any I/O.
  const qa = analyzeQuery(q, filters)
  const decision = smartRouter(q, filters, qa)
  const shadowEnabled = Boolean(discovery.fantasticJobsApiKey) && await isRuntimeFeatureEnabled('fantasticjobs_shadow', auth.userId).catch(() => false)
  const cacheCalls = shadowEnabled
    ? [...decision.sources, { id: 'fantasticjobs' as SourceId, params: {} }]
    : decision.sources
  const cKey = createDiscoveryCacheKey({
    query: { q, location: filters.location, remote: filters.remote, jobType: filters.jobType, datePosted: filters.datePosted, experience: filters.experience, salaryMin: filters.salaryMin, salaryMax: filters.salaryMax },
    providers: cacheCalls.map(call => call.id),
    credentialScope: credentialCacheScope({ userId: auth.userId, providerScopes: cacheProviderScopes(cacheCalls, filters) }),
  })
  if (!noCache) {
    const hit = await getDiscoveryCache<{ jobs: JobResult[]; meta: Record<string, unknown> }>(cKey)
    if (hit) {
      void recordDiscoveryOptimization({ userId: auth.userId, eventType: 'cache_hit', credentialScope: 'user', requestsAvoided: 1, metadata: { layer: hit.layer } })
      return ok({ ...hit.value, meta: { ...hit.value.meta, cached: true, cacheLayer: hit.layer } })
    }
  }

  const t0 = Date.now()

  // ② Detect country code for salary context
  const country = detectCountry((q + ' ' + filters.location).toLowerCase())
  const ccForSalary = country === 'gb' || country === 'ie' ? 'gb'
                    : DACH_COUNTRIES.has(country ?? '') ? 'de'
                    : country ?? 'us'
  const salaryScope = credentialCacheScope({
    userId: auth.userId,
    providerScopes: { salary: filters.usage?.rapidapiSource === 'user' ? 'user' : 'platform' },
  })

  // ③ Provider execution is cacheable and singleflight-protected. Free sources
  // run together; paid sources are selected one at a time until the result gap
  // is filled or quota/health policy skips them.
  const providerPromise = runDiscoverySingleflight(cKey, () => executeSearchProviders(decision.sources, filters, shadowEnabled, {
    title: cleanSearchTitle(q) || q,
    location: filters.location,
    datePosted: filters.datePosted,
  }))
  const salaryPromise = runDiscoverySingleflight(`${cKey}:salary:${salaryScope}`, () => fetchSalaryCtx(q, ccForSalary, discovery.rapidapiKey, filters))
  const [providerResult, salaryResult] = await Promise.all([
    providerPromise,
    salaryPromise,
  ])
  if (providerResult.joined) {
    void recordDiscoveryOptimization({ userId: auth.userId, eventType: 'singleflight_hit', credentialScope: 'user', requestsAvoided: 1 })
  }
  if (salaryResult.joined) {
    void recordDiscoveryOptimization({ userId: auth.userId, eventType: 'singleflight_hit', credentialScope: 'user', requestsAvoided: 1, metadata: { route: 'salary_context' } })
  }
  if (!providerResult.joined) {
    void Promise.all(providerResult.value.decisions.map(decision => recordDiscoveryOptimization({
      userId: auth.userId,
      eventType: decision.action === 'selected' ? 'provider_selected' : 'provider_skipped',
      provider: decision.provider,
      credentialScope: providerCredentialSource(decision.provider, filters),
      reasonCode: decision.reason,
      metadata: { quotaBand: decision.quotaBand },
    })))
  }
  const raw: JobResult[] = providerResult.value.items
  const shadowJobs = providerResult.value.shadowItems
  const totalRaw = raw.length

  // ④ Dedup → score → post-filter → sort. Removing duplicate payloads before
  // scoring keeps repeated provider results from consuming downstream work.
  const preDeduped = smartDedup(raw)
  const scored   = scoreSearchJobs(preDeduped, q, filters)
  const deduped  = smartDedup(scored)
  const filtered = postFilter(deduped, filters)
  const sorted   = filtered.sort((a, b) => b.score - a.score)

  if (!providerResult.joined && shadowEnabled) {
    const evidence = compareShadowJobs(sorted, shadowJobs)
    void recordDiscoveryOptimization({
      userId: auth.userId, eventType: 'shadow_comparison', provider: 'fantasticjobs', credentialScope: 'platform',
      jobsReturned: evidence.shadowJobs, netNewJobs: evidence.netNewJobs,
      validApplyUrls: evidence.validApplyUrls, completeDescriptions: evidence.completeDescriptions,
      metadata: { visibleJobs: sorted.length, route: 'unified_search' },
    })
  }

  // ⑤ Build enriched meta
  const withHM = sorted.filter(j => j.hiringManager).length
  const hasRapidKey  = !!discovery.rapidapiKey
  const hasAdzunaKey = !!(discovery.adzunaAppId && discovery.adzunaAppKey)

  const meta = {
    sourcesUsed:       providerResult.value.decisions.filter(decision => decision.action === 'selected').map(decision => decision.provider),
    sourceBreakdown:   buildSourceBreakdown(sorted),
    routing:           decision.reasoning,
    providerDecisions: providerResult.value.decisions,
    shadow: shadowEnabled ? { enabled: true, provider: 'fantasticjobs' } : { enabled: false },
    queryAnalysis: {
      isCompanyQuery: qa.isCompanyQuery,
      isRemote:       qa.isRemote,
      hasBoolean:     qa.hasBoolean,
    },
    totalRaw,
    totalDeduped:      deduped.length,
    totalFiltered:     sorted.length,
    withHiringManager: withHM,
    topSkills:         aggregateTopSkills(sorted),
    salaryContext:     salaryResult.value,
    durationMs:        Date.now() - t0,
    cached:            false,
    // API key status — helps diagnose "no results" issues
    apiKeys: {
      rapidapi:  hasRapidKey,
      adzuna:    hasAdzunaKey,
      reed:      !!(process.env.REED_API_KEY),
      careerjet: !!(process.env.CAREERJET_AFFID),
      cleanjobdata: !!discovery.cleanJobDataApiKey,
      fantasticjobs: !!discovery.fantasticJobsApiKey,
    },
  }

  const response = { jobs: sorted, meta }

  // ⑥ Cache the normalized result after scoring so future requests skip all
  // provider calls but still receive the current request's route metadata.
  if (!noCache) await setDiscoveryCache(cKey, response)

  return ok(response)
}
