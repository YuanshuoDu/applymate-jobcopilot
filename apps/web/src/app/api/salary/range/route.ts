/**
 * GET /api/salary/range?title=software+engineer&country=de
 * Returns market salary benchmark for a given job title in a given country.
 * Uses jobs-api14 (RapidAPI). Requires RAPIDAPI_KEY.
 *
 * Response:
 *   {
 *     country, currency,
 *     yearly:  { min, max, mean, median },
 *     monthly: { min, max, mean, median },
 *     hourly:  { min, max, mean, median },
 *   }
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

const HOST = 'jobs-api14.p.rapidapi.com'

interface SalaryBlock {
  min:    number
  max:    number
  mean:   number
  median: number
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const apiKey = process.env.RAPIDAPI_KEY
  if (!apiKey) return err('RapidAPI key not configured.', 501)

  const { searchParams } = req.nextUrl
  const title   = searchParams.get('title')?.trim()
  const country = (searchParams.get('country') ?? 'us').toLowerCase()
  if (!title) return err('title is required')

  const params = new URLSearchParams({ query: title, countryCode: country })

  let raw: Response
  try {
    raw = await fetch(`https://${HOST}/v2/salary/range?${params}`, {
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach salary API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Salary API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as {
    data?: {
      country?:        string
      countryCode?:    string
      currency?:       string
      yearlySalary?:   SalaryBlock
      monthlySalary?:  SalaryBlock
      hourlySalary?:   SalaryBlock
    }
    warnings?: Array<{ code: number; error: string; message: string; field: string }>
    hasWarning?: boolean
  }

  const d = json.data
  if (!d || !d.yearlySalary || d.yearlySalary.max === 0) {
    // No data for this title — try to suggest related titles via /v2/salary/titles
    return ok({
      hasData: false,
      message: '该岗位+国家组合暂无薪资数据，可尝试更通用的岗位名（如 "software engineer"）',
      country,
    })
  }

  const round = (n: number) => Math.round(n)
  const block = (b: SalaryBlock) => ({ min: round(b.min), max: round(b.max), mean: round(b.mean), median: round(b.median) })

  return ok({
    hasData:  true,
    country:  d.country ?? country.toUpperCase(),
    currency: d.currency ?? '',
    yearly:   block(d.yearlySalary),
    monthly:  d.monthlySalary ? block(d.monthlySalary) : null,
    hourly:   d.hourlySalary  ? block(d.hourlySalary)  : null,
  })
}
