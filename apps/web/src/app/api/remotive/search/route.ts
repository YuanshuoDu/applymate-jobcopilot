/**
 * GET /api/remotive/search
 * Remotive — free remote-only job listings, tech-focused.
 * No API key required. Max ~4 requests/day recommended per docs.
 *
 * Params:
 *   q        string  — keyword search (title + description)
 *   category string  — software-dev | devops-sysadmin | design | data |
 *                      finance-legal | product | business | sales | marketing |
 *                      customer-support | (empty = all)
 *   limit    number  — max results (default 20, max 100)
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { truncate } from '@/lib/utils'

// Map our generic jobType to Remotive categories
const CATEGORY_MAP: Record<string, string> = {
  software:    'software-dev',
  engineering: 'software-dev',
  devops:      'devops-sysadmin',
  design:      'design',
  data:        'data',
  finance:     'finance-legal',
  legal:       'finance-legal',
  product:     'product',
  marketing:   'marketing',
  sales:       'sales',
  support:     'customer-support',
}

// Detect best Remotive category from free-text query
function inferCategory(q: string): string {
  const l = q.toLowerCase()
  if (/\b(devops|docker|kubernetes|k8s|infra|sre|platform)\b/.test(l)) return 'devops-sysadmin'
  if (/\b(design|ux|ui|figma|product design)\b/.test(l)) return 'design'
  if (/\b(data|analytics|ml|machine learning|ai|scientist)\b/.test(l)) return 'data'
  if (/\b(finance|accounting|legal|compliance)\b/.test(l)) return 'finance-legal'
  if (/\b(product manager|pm|roadmap)\b/.test(l)) return 'product'
  if (/\b(sales|account executive|revenue)\b/.test(l)) return 'sales'
  if (/\b(market|content|seo|growth)\b/.test(l)) return 'marketing'
  if (/\b(support|customer success|helpdesk)\b/.test(l)) return 'customer-support'
  if (/\b(software|developer|engineer|backend|frontend|fullstack|full.stack|react|node|python|java)\b/.test(l)) return 'software-dev'
  return ''  // no category → search all
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const sp       = req.nextUrl.searchParams
  const q        = sp.get('q')?.trim() ?? ''
  const category = sp.get('category')?.trim() ?? CATEGORY_MAP[sp.get('category') ?? ''] ?? inferCategory(q)
  const limit    = Math.min(100, parseInt(sp.get('limit') ?? '20', 10))

  const params = new URLSearchParams({ limit: String(limit) })
  if (q)        params.set('search', q)
  if (category) params.set('category', category)

  let raw: Response
  try {
    raw = await fetch(`https://remotive.com/api/remote-jobs?${params}`, {
      headers: { 'User-Agent': 'ApplyMate/1.0' },
      next: { revalidate: 900 },  // cache 15 min to respect rate limits
    })
  } catch { return err('Failed to reach Remotive API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Remotive API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as {
    'job-count'?: number
    jobs?: Array<{
      id:                          number
      url:                         string
      title:                       string
      company_name:                string
      company_logo:                string
      category:                    string
      tags:                        string[]
      job_type:                    string
      publication_date:            string
      candidate_required_location: string
      salary:                      string
      description:                 string
    }>
  }

  const JOB_TYPE_MAP: Record<string, string> = {
    full_time: 'Full Time',
    contract:  'Contract',
    part_time: 'Part Time',
    freelance: 'Freelance',
  }

  const jobs = (json.jobs ?? []).map(r => ({
    id:          String(r.id),
    title:       r.title,
    company:     r.company_name,
    logo:        r.company_logo || null,
    location:    r.candidate_required_location || 'Remote',
    salary:      r.salary || undefined,
    description: truncate(r.description?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') ?? ''),
    url:         r.url,
    postedAt:    r.publication_date ?? null,
    jobType:     JOB_TYPE_MAP[r.job_type] ?? r.job_type ?? null,
    tags:        r.tags ?? [],
    category:    r.category ?? null,
    source:      'remotive' as const,
  }))

  return ok({ jobs, total: json['job-count'] ?? jobs.length })
}
