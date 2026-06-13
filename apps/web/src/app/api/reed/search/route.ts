/**
 * GET /api/reed/search
 * Reed.co.uk — UK's leading job board. High-quality direct employer listings.
 * Free API with registration at https://www.reed.co.uk/developers
 *
 * Requires REED_API_KEY in environment (Base64 encode "<key>:" for Basic Auth).
 * Get your key at: https://www.reed.co.uk/developers/jobseeker
 *
 * Params:
 *   q              string  — keywords
 *   location       string  — UK city or postcode
 *   radius         number  — distance in miles (default 10)
 *   page           number  — 1-based page
 *   jobType        string  — fulltime | parttime | contract
 *   salaryMin      number  — minimum salary (£)
 *   salaryMax      number  — maximum salary (£)
 *   postedByDirect 0|1     — 1 = direct employers only
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

const BASE      = 'https://www.reed.co.uk/api/1.0/search'
const PAGE_SIZE = 20

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const reedKey = process.env.REED_API_KEY
  if (!reedKey) return err('Reed API not configured. Register at reed.co.uk/developers and add REED_API_KEY to .env.local.', 501)

  const sp           = req.nextUrl.searchParams
  const q            = sp.get('q')?.trim() ?? ''
  const location     = sp.get('location')?.trim() ?? ''
  const radius       = sp.get('radius') ?? '10'
  const page         = Math.max(1, parseInt(sp.get('page') ?? '1', 10))
  const jobType      = sp.get('jobType') ?? ''
  const salaryMin    = sp.get('salaryMin') ? Number(sp.get('salaryMin')) * 1000 : null
  const salaryMax    = sp.get('salaryMax') ? Number(sp.get('salaryMax')) * 1000 : null
  const directOnly   = sp.get('postedByDirect') === '1'

  if (!q && !location) return err('q or location is required')

  const resultsFrom = (page - 1) * PAGE_SIZE

  const params = new URLSearchParams({
    resultsToTake: String(PAGE_SIZE),
    resultsToSkip: String(resultsFrom),
  })
  if (q)           params.set('keywords', q)
  if (location)    params.set('locationName', location)
  if (radius)      params.set('distanceFromLocation', radius)
  if (salaryMin)   params.set('minimumSalary', String(salaryMin))
  if (salaryMax)   params.set('maximumSalary', String(salaryMax))
  if (directOnly)  params.set('postedByDirectEmployer', 'true')

  if (jobType === 'fulltime')   params.set('fullTime', 'true')
  else if (jobType === 'parttime') params.set('partTime', 'true')
  else if (jobType === 'contract') params.set('contract', 'true')

  // Reed uses Basic auth: base64("<apikey>:")
  const credentials = Buffer.from(`${reedKey}:`).toString('base64')

  let raw: Response
  try {
    raw = await fetch(`${BASE}?${params}`, {
      headers: { Authorization: `Basic ${credentials}` },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach Reed API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Reed API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as {
    totalResults?: number
    results?: Array<{
      jobId:          number
      employerId:     number
      employerName:   string
      jobTitle:       string
      locationName:   string
      minimumSalary?: number
      maximumSalary?: number
      currency?:      string
      jobUrl:         string
      jobDescription: string
      date:           string
      contractType?:  string
      contractTime?:  string
    }>
  }

  const jobs = (json.results ?? []).map(r => {
    const min = r.minimumSalary
    const max = r.maximumSalary
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
      jobType:     r.contractTime ?? r.contractType ?? null,
      source:      'reed' as const,
    }
  })

  return ok({ jobs, total: json.totalResults ?? jobs.length, page })
}
