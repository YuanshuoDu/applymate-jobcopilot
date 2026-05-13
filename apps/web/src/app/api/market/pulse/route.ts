/**
 * GET /api/market/pulse
 * Market intelligence for the Dashboard.
 *
 * Uses the user's configured target roles + locations to query the job market
 * and return actionable intelligence:
 *   - Salary benchmark for their primary target role
 *   - Top skills in demand for that role
 *   - Top companies actively hiring
 *   - Job volume (fresh listings count)
 *   - Work arrangement breakdown (remote% / hybrid% / on-site%)
 *
 * Results are cached 1 hour (salary) and 15 min (job listings).
 * Falls back gracefully if API keys are not configured.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { truncate } from '@/lib/utils'

// In-memory cache per userId (market data changes slowly)
const _pulseCache = new Map<string, { data: object; exp: number }>()
const PULSE_TTL = 15 * 60 * 1000   // 15 min

function getCached(key: string): object | null {
  const e = _pulseCache.get(key)
  if (!e || Date.now() > e.exp) { _pulseCache.delete(key); return null }
  return e.data
}
function setCached(key: string, data: object) {
  _pulseCache.set(key, { data, exp: Date.now() + PULSE_TTL })
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { userId } = auth
  const noCache = req.nextUrl.searchParams.get('noCache') === '1'

  // Check pulse cache
  if (!noCache) {
    const hit = getCached(userId)
    if (hit) return ok({ ...(hit as object), cached: true })
  }

  // Get user's agent config for target roles / locations
  const agentCfg = await db.agentConfig.findUnique({ where: { userId } })
  const roles     = agentCfg?.targetRoles     ?? []
  const locations = agentCfg?.targetLocations ?? []

  const primaryRole     = roles[0]     ?? ''
  const primaryLocation = locations[0] ?? ''

  const rapidKey   = process.env.RAPIDAPI_KEY   ?? ''
  const adzunaId   = process.env.ADZUNA_APP_ID  ?? ''
  const adzunaKey  = process.env.ADZUNA_APP_KEY ?? ''

  // ── Parallel data collection ──────────────────────────────────────────────
  const [salaryData, jobsData] = await Promise.all([
    primaryRole && rapidKey ? fetchSalary(primaryRole, primaryLocation, rapidKey) : Promise.resolve(null),
    primaryRole && rapidKey ? fetchRecentJobs(primaryRole, primaryLocation, rapidKey, adzunaId, adzunaKey) : Promise.resolve([]),
  ])

  // ── Aggregate job intelligence ────────────────────────────────────────────
  const topSkills      = aggregateSkills(jobsData, 10)
  const topCompanies   = aggregateCompanies(jobsData, 8)
  const arrangements   = aggregateArrangements(jobsData)
  const freshCount     = jobsData.length

  const pulse = {
    primaryRole,
    primaryLocation,
    freshJobCount:    freshCount,
    salaryContext:    salaryData,
    topSkills,
    topCompanies,
    workArrangements: arrangements,
    cached:           false,
    generatedAt:      new Date().toISOString(),
  }

  setCached(userId, pulse)
  return ok(pulse)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchSalary(
  role: string,
  location: string,
  rapidKey: string,
): Promise<{ currency: string; median: number; min: number; max: number } | null> {
  const loc = location.toLowerCase()
  const ccMap: Record<string, string> = {
    // Ireland — use IE for EUR salary context (not GB)
    ireland: 'ie', dublin: 'ie', cork: 'ie', galway: 'ie', limerick: 'ie',
    'silicon docks': 'ie', sandyford: 'ie',
    // UK
    uk: 'gb', 'united kingdom': 'gb', london: 'gb',
    // Europe
    germany: 'de', berlin: 'de', munich: 'de',
    france: 'fr', netherlands: 'nl', spain: 'es', 'switzerland': 'ch',
  }
  let cc = 'us'
  for (const [kw, code] of Object.entries(ccMap)) {
    if (loc.includes(kw)) { cc = code; break }
  }

  const cleanRole = role.replace(/\b(senior|sr|junior|jr|lead|staff|principal)\b/gi, '').trim()
  try {
    const p = new URLSearchParams({ query: cleanRole, countryCode: cc })
    const res = await fetch(`https://jobs-api14.p.rapidapi.com/v2/salary/range?${p}`, {
      headers: { 'x-rapidapi-key': rapidKey, 'x-rapidapi-host': 'jobs-api14.p.rapidapi.com' },
      next: { revalidate: 3600 },
    })
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

interface PulseJob {
  company:         string
  keySkills:       string[]
  workArrangement: string | null
}

async function fetchRecentJobs(
  role: string,
  location: string,
  rapidKey: string,
  adzunaId: string,
  adzunaKey: string,
): Promise<PulseJob[]> {
  const results: PulseJob[] = []

  // Use ATS API — has AI key skills and work arrangement
  try {
    const p = new URLSearchParams({
      title_filter:     role,
      description_type: 'text',
      limit:            '30',
      include_ai:       'true',
    })
    if (location) p.set('location_filter', location)
    const res = await fetch(`https://active-jobs-db.p.rapidapi.com/active-ats-7d?${p}`, {
      headers: { 'x-rapidapi-key': rapidKey, 'x-rapidapi-host': 'active-jobs-db.p.rapidapi.com' },
      signal: AbortSignal.timeout(6_000), cache: 'no-store',
    })
    if (res.ok) {
      const json = await res.json()
      if (Array.isArray(json)) {
        for (const j of json) {
          results.push({
            company:         j.organization ?? '',
            keySkills:       j.ai_key_skills ?? [],
            workArrangement: j.ai_work_arrangement ?? null,
          })
        }
      }
    }
  } catch { /* non-fatal */ }

  // Supplement with LinkedIn (also has AI skills)
  try {
    const p = new URLSearchParams({
      title_filter:     role,
      description_type: 'text',
      limit:            '20',
      include_ai:       'true',
      exclude_ats_duplicate: 'true',
    })
    if (location) p.set('location_filter', location)
    const res = await fetch(`https://linkedin-job-search-api.p.rapidapi.com/active-jb-24h?${p}`, {
      headers: { 'x-rapidapi-key': rapidKey, 'x-rapidapi-host': 'linkedin-job-search-api.p.rapidapi.com' },
      signal: AbortSignal.timeout(5_000), cache: 'no-store',
    })
    if (res.ok) {
      const json = await res.json()
      if (Array.isArray(json)) {
        for (const j of json) {
          results.push({
            company:         j.organization ?? '',
            keySkills:       j.ai_key_skills ?? [],
            workArrangement: j.ai_work_arrangement ?? null,
          })
        }
      }
    }
  } catch { /* non-fatal */ }

  return results
}

function aggregateSkills(jobs: PulseJob[], n: number): Array<{ skill: string; count: number }> {
  const counts = new Map<string, number>()
  for (const j of jobs) {
    for (const sk of j.keySkills) {
      const k = sk.toLowerCase()
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([skill, count]) => ({ skill, count }))
}

function aggregateCompanies(jobs: PulseJob[], n: number): Array<{ company: string; openings: number }> {
  const counts = new Map<string, number>()
  for (const j of jobs) {
    if (j.company) counts.set(j.company, (counts.get(j.company) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([c]) => c.trim())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([company, openings]) => ({ company, openings }))
}

function aggregateArrangements(jobs: PulseJob[]): {
  remote: number; hybrid: number; onsite: number; unknown: number; total: number
} {
  let remote = 0, hybrid = 0, onsite = 0, unknown = 0
  for (const j of jobs) {
    const wa = j.workArrangement?.toLowerCase() ?? ''
    if (wa.includes('remote')) remote++
    else if (wa.includes('hybrid')) hybrid++
    else if (wa.includes('on-site') || wa.includes('onsite')) onsite++
    else unknown++
  }
  return { remote, hybrid, onsite, unknown, total: jobs.length }
}
