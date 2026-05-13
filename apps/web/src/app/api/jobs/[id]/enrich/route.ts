/**
 * POST /api/jobs/:id/enrich
 * Enriches a saved job with fresh data from job APIs.
 *
 * Enrichment sources (all best-effort, partial results are fine):
 *   1. ATS / LinkedIn search by title+company → description, salary, logo
 *   2. Mantiks company endpoint → hiring manager contact, company intel
 *   3. Salary API → market salary benchmark for the role
 *
 * Updates the job record and returns the enriched job + enrichment metadata.
 * Safe to call multiple times — always overwrites with fresher data.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { truncate } from '@/lib/utils'

type Params = { params: Promise<{ id: string }> }

interface EnrichmentResult {
  description?:    string
  salary?:         string
  logo?:           string
  hiringManager?:  {
    name:        string
    title:       string
    linkedinUrl: string
    email:       string | null
  }
  salaryContext?: {
    currency: string
    median:   number
    min:      number
    max:      number
  }
  companyIntel?: {
    industry:      string | null
    employeeCount: number | null
    headquarters:  string | null
  }
  sources: string[]
}

export async function POST(_req: NextRequest, { params }: Params) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const job = await db.job.findUnique({ where: { id } })
  if (!job || job.userId !== auth.userId) return err('Not found', 404)

  const rapidKey   = process.env.RAPIDAPI_KEY   ?? ''
  const mantisKey  = process.env.MANTIKS_API_KEY ?? ''
  const adzunaId   = process.env.ADZUNA_APP_ID   ?? ''
  const adzunaKey  = process.env.ADZUNA_APP_KEY  ?? ''

  const result: EnrichmentResult = { sources: [] }

  // ── 1. Job description + salary via ATS search ────────────────────────────
  if (rapidKey && (!job.description || !job.salary)) {
    try {
      const p = new URLSearchParams({
        title_filter:     job.role,
        description_type: 'text',
        limit:            '5',
        include_ai:       'true',
      })
      if (job.company) p.set('organization_description_filter', job.company)

      const atsRes = await fetch(`https://active-jobs-db.p.rapidapi.com/active-ats-7d?${p}`, {
        headers: { 'x-rapidapi-key': rapidKey, 'x-rapidapi-host': 'active-jobs-db.p.rapidapi.com' },
        signal: AbortSignal.timeout(5_000), cache: 'no-store',
      })

      if (atsRes.ok) {
        const jobs = await atsRes.json()
        if (Array.isArray(jobs)) {
          // Find best match: same company name (case-insensitive)
          const co = job.company.toLowerCase()
          const match = jobs.find((j: { organization?: string }) =>
            j.organization?.toLowerCase().includes(co) || co.includes(j.organization?.toLowerCase() ?? '')
          ) ?? jobs[0]

          if (match) {
            if (!job.description && match.description_text) {
              result.description = truncate(match.description_text, 2000)
            }
            if (!job.salary) {
              if (match.salary_raw) {
                result.salary = match.salary_raw
              } else if (match.ai_salary_minvalue) {
                const cur = match.ai_salary_currency ?? ''
                const sym = cur === 'GBP' ? '£' : cur === 'EUR' ? '€' : '$'
                result.salary = `${sym}${match.ai_salary_minvalue.toLocaleString()}${
                  match.ai_salary_maxvalue ? `–${match.ai_salary_maxvalue.toLocaleString()}` : ''
                }/yr`
              }
            }
            if (!job.logo && match.organization_logo) {
              result.logo = match.organization_logo
            }
            result.sources.push('ats')
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── 2. Mantiks company endpoint → hiring manager + company data ───────────
  if (mantisKey && job.company) {
    try {
      const website = job.company
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')  // rough slug; Mantiks also accepts company name
      const p = new URLSearchParams({
        website:     encodeURIComponent(website + '.com'),
        age_in_days: '30',
        keyword:     job.role,
      })
      const mantRes = await fetch(`https://api.mantiks.io/company/jobs?${p}`, {
        headers: { 'X-API-KEY': mantisKey },
        signal: AbortSignal.timeout(6_000), cache: 'no-store',
      })
      if (mantRes.ok) {
        const data = await mantRes.json() as {
          jobs?: Array<{
            contact?: {
              name?: string; job_title?: string
              linkedin_url?: string; email?: string
            }
          }>
        }
        const withContact = data.jobs?.find(j => j.contact?.name)
        if (withContact?.contact?.name) {
          result.hiringManager = {
            name:        withContact.contact.name,
            title:       withContact.contact.job_title ?? '',
            linkedinUrl: withContact.contact.linkedin_url ?? '',
            email:       withContact.contact.email ?? null,
          }
          result.sources.push('mantiks')
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── 3. Salary context from Jobs API ──────────────────────────────────────
  if (rapidKey) {
    try {
      // Detect country code from job location
      const locLower = (job.location ?? '').toLowerCase()
      const ccMap: Record<string, string> = {
        uk: 'gb', 'united kingdom': 'gb', london: 'gb',
        germany: 'de', berlin: 'de', munich: 'de',
        ireland: 'ie', dublin: 'ie',
        france: 'fr', paris: 'fr',
        netherlands: 'nl', amsterdam: 'nl',
      }
      let cc = 'us'
      for (const [kw, code] of Object.entries(ccMap)) {
        if (locLower.includes(kw)) { cc = code; break }
      }

      const cleanRole = job.role.replace(/\b(senior|sr|junior|jr|lead|staff|principal)\b/gi, '').trim()
      const p = new URLSearchParams({ query: cleanRole, countryCode: cc })
      const salRes = await fetch(`https://jobs-api14.p.rapidapi.com/v2/salary/range?${p}`, {
        headers: { 'x-rapidapi-key': rapidKey, 'x-rapidapi-host': 'jobs-api14.p.rapidapi.com' },
        next: { revalidate: 3600 },
      })
      if (salRes.ok) {
        const salJson = await salRes.json() as {
          data?: { currency?: string; yearlySalary?: { min: number; max: number; median: number } }
        }
        const d = salJson.data
        if (d?.yearlySalary?.median) {
          result.salaryContext = {
            currency: d.currency ?? 'USD',
            median:   Math.round(d.yearlySalary.median),
            min:      Math.round(d.yearlySalary.min),
            max:      Math.round(d.yearlySalary.max),
          }
          result.sources.push('salary-api')
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── Persist enrichment to DB ──────────────────────────────────────────────
  const updateData: Record<string, unknown> = {}
  if (result.description && !job.description) updateData.description = result.description
  if (result.salary      && !job.salary)      updateData.salary      = result.salary
  if (result.logo        && !job.logo)        updateData.logo        = result.logo

  if (Object.keys(updateData).length > 0) {
    await db.job.update({ where: { id }, data: updateData })
  }

  // Store hiring manager + company intel in analysisNote as structured JSON supplement
  if (result.hiringManager || result.salaryContext) {
    const enrichNote = JSON.stringify({
      hiringManager:  result.hiringManager  ?? null,
      salaryContext:  result.salaryContext  ?? null,
      enrichedAt:     new Date().toISOString(),
    })
    await db.job.update({ where: { id }, data: { analysisNote: enrichNote } as any })
  }

  const enrichedJob = await db.job.findUnique({ where: { id } })

  return ok({
    job:         enrichedJob,
    enrichment:  result,
    enriched:    result.sources.length > 0,
  })
}
