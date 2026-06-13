/**
 * GET /api/jobicy/search
 * Params: q (tag), geo, industry, count (max 50)
 * Proxies Jobicy remote jobs API — completely free, no key required.
 * Remote positions only.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

const BASE = 'https://jobicy.com/api/v2/remote-jobs'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { searchParams } = req.nextUrl
  const tag      = searchParams.get('q')?.trim() ?? ''
  const geo      = searchParams.get('geo')?.trim() ?? ''
  const industry = searchParams.get('industry')?.trim() ?? ''
  const count    = Math.min(parseInt(searchParams.get('count') ?? '50', 10), 50)

  const params = new URLSearchParams({ count: String(count) })
  if (tag)      params.set('tag', tag)
  if (geo)      params.set('geo', geo)
  if (industry) params.set('industry', industry)

  let raw: Response
  try {
    raw = await fetch(`${BASE}?${params}`, {
      headers: { 'User-Agent': 'ApplyMate/1.0' },
      cache:   'no-store',
    })
  } catch {
    return err('Failed to reach Jobicy API', 502)
  }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Jobicy error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as {
    jobs: Array<{
      id:          number
      url:         string
      jobTitle:    string
      companyName: string
      jobIndustry: string[]
      jobType:     string[]
      jobGeo:      string
      jobExcerpt:  string
      pubDate:     string
      annualSalaryMin?: number
      annualSalaryMax?: number
      salaryCurrency?:  string
    }>
    jobCount?: number
  }

  const jobs = (json.jobs ?? []).map(r => {
    const hasSalary = r.annualSalaryMin || r.annualSalaryMax
    const sym       = r.salaryCurrency === 'GBP' ? '£' : r.salaryCurrency === 'EUR' ? '€' : '$'
    const fmt       = (n: number) => `${sym}${Math.round(n / 1000)}k`
    const salary    = hasSalary
      ? (r.annualSalaryMin && r.annualSalaryMax
          ? `${fmt(r.annualSalaryMin)} – ${fmt(r.annualSalaryMax)}`
          : r.annualSalaryMin ? `${fmt(r.annualSalaryMin)}+` : undefined)
      : undefined

    return {
      id:          String(r.id),
      title:       r.jobTitle,
      company:     r.companyName,
      location:    r.jobGeo || 'Remote',
      salary,
      description: truncate(r.jobExcerpt ?? ''),
      url:         r.url,
      postedAt:    r.pubDate ?? null,
      jobType:     r.jobType?.join(', ') || null,
      source:      'jobicy' as const,
    }
  })

  return ok({ jobs, total: json.jobCount ?? jobs.length, page: 1 })
}
