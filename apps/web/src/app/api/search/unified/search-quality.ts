import { resolveLocation } from '@/lib/agent/location-resolver'

export interface SearchJob {
  id: string
  title: string
  company: string
  location: string
  salary?: string
  description: string
  url: string
  postedAt?: string | null
  jobType?: string | null
  logo?: string | null
  seniority?: string | null
  directApply?: boolean
  keySkills?: string[]
  workArrangement?: string | null
  experienceLevel?: string | null
  hiringManager?: { name: string; title: string; linkedinUrl: string; email: string | null; phone: string | null } | null
  source: 'adzuna' | 'jsearch' | 'linkedin' | 'jobicy' | 'ats' | 'internships' | 'irishjobs' | 'xing' | 'indeed' | 'remotive' | 'bundesagentur' | 'reed' | 'careerjet' | 'mantiks'
  score: number
}

export interface SearchFilters {
  location: string
  remote: boolean
  jobType: string
  datePosted: string
  experience: string
  salaryMin?: number
  salaryMax?: number
}

const REMOTE_VERIFIED_SOURCES = new Set<string>(['jobicy', 'remotive', 'ats', 'internships'])
const STRIP_TITLE = /\b(remote|hybrid|onsite|contract|temp|interim)\b/gi
const SHORT_ROLE_TERMS = new Set(['ai', 'ml', 'ui', 'ux', 'qa', 'pm', 'hr', 'go', 'c#'])

export function cleanSearchTitle(query: string): string {
  return query
    .replace(/\b(remote|hybrid|onsite|senior|sr|junior|jr|lead|principal|staff)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function queryKeywords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(word => word.length > 2 || SHORT_ROLE_TERMS.has(word))
}

export function scoreSearchJobs(jobs: SearchJob[], query: string, filters: SearchFilters): SearchJob[] {
  const queryText = query.toLowerCase()
  const words = queryKeywords(queryText)
  const titleTerms = words.filter(word => !['senior', 'junior', 'entry', 'graduate', 'lead', 'remote'].includes(word))
  const remote = filters.remote || /\b(remote|wfh|distributed)\b/.test(queryText)
  const experiencePatterns: Record<string, RegExp> = {
    entry: /\b(junior|entry|graduate|intern|fresher)\b/i,
    mid: /\b(mid|intermediate|ii|level 2)\b/i,
    senior: /\b(senior|sr\.?|staff|principal|iii|level 3)\b/i,
    lead: /\b(lead|manager|head|director|vp|principal)\b/i,
  }
  return jobs.map(job => {
    const title = job.title.toLowerCase()
    const description = job.description.toLowerCase().slice(0, 300)
    const titleMatches = titleTerms.filter(term => title.includes(term)).length
    let score = titleMatches * 5
    if (title.includes(queryText)) score += 8
    if (titleTerms.length >= 2 && titleMatches === 0) score -= 8
    if (job.description) score += 2 + Math.min(words.filter(term => description.includes(term)).length, 3)
    if (job.keySkills?.length) score += Math.min(job.keySkills.filter(skill => words.some(term => skill.toLowerCase().includes(term))).length * 2, 6)
    if (remote && (job.workArrangement === 'Remote Solely' || job.workArrangement === 'Remote OK')) score += 3
    if (job.postedAt) {
      const days = (Date.now() - new Date(job.postedAt).getTime()) / 86_400_000
      score += days < 1 ? 5 : days < 3 ? 4 : days < 7 ? 3 : days < 14 ? 2 : days < 30 ? 1 : 0
    }
    if (job.salary) score += 1
    if (job.hiringManager) score += 4
    if (filters.experience && experiencePatterns[filters.experience]?.test(job.title)) score += 4
    if (job.source === 'linkedin') score += 2
    if (job.directApply) score += 3
    if (job.source === 'irishjobs') score += 3
    if (job.source === 'bundesagentur') score += 2
    if (filters.location && matchesRequestedLocation(job.location, filters.location)) score += 6
    return { ...job, score }
  })
}

function normalizeUrl(url: string): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const tracking = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'trk', 'ref', 'source', 'origin', 'referer', 'viewId', 'trackingId', 'sid', 'cid']
    tracking.forEach(param => parsed.searchParams.delete(param))
    return (parsed.origin + parsed.pathname).toLowerCase().replace(/\/$/, '')
  } catch {
    return url.toLowerCase().split('?')[0].replace(/\/$/, '')
  }
}

function fuzzyJobKey(title: string, company: string): string {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(STRIP_TITLE, '').replace(/\s+/g, ' ').trim().slice(0, 45)
  return `${clean(title)}||${clean(company)}`
}

function isBetter(candidate: SearchJob, existing: SearchJob): boolean {
  return (!existing.salary && Boolean(candidate.salary))
    || (!existing.description && Boolean(candidate.description))
    || (!existing.logo && Boolean(candidate.logo))
    || (!existing.directApply && Boolean(candidate.directApply))
    || (!(existing.keySkills?.length) && Boolean(candidate.keySkills?.length))
}

export function smartDedup(jobs: SearchJob[]): SearchJob[] {
  const byUrl = new Map<string, number>()
  const byFuzzy = new Map<string, number>()
  const results: SearchJob[] = []
  for (const job of jobs) {
    const url = normalizeUrl(job.url)
    const key = fuzzyJobKey(job.title, job.company)
    const byUrlIndex = url ? byUrl.get(url) : undefined
    const existingIndex = byUrlIndex ?? (key ? byFuzzy.get(key) : undefined)
    if (existingIndex !== undefined) {
      if (isBetter(job, results[existingIndex])) results[existingIndex] = { ...job, score: results[existingIndex].score }
      continue
    }
    const index = results.length
    results.push(job)
    if (url) byUrl.set(url, index)
    if (key) byFuzzy.set(key, index)
  }
  return results
}

function parseSalaryNum(salary?: string): { min: number; max: number } | null {
  if (!salary) return null
  const numbers = salary.match(/\d[\d,.]*/g)?.map(value => Number.parseFloat(value.replace(/,/g, ''))) ?? []
  if (numbers.length === 0) return null
  const scaled = numbers.map(value => value < 1000 ? value * 1000 : value)
  return { min: scaled[0], max: scaled[1] ?? scaled[0] }
}

function matchesRequestedLocation(jobLocation: string, requestedLocation: string) {
  const job = jobLocation.trim().toLowerCase()
  if (!job) return false
  const requested = requestedLocation.trim().toLowerCase()
  if (job.includes(requested)) return true
  const resolved = resolveLocation(requestedLocation)
  return resolved.isCountry && resolved.dbTerms.some(term => job.includes(term))
}

export function postFilter(jobs: SearchJob[], filters: SearchFilters): SearchJob[] {
  return jobs.filter(job => {
    if (filters.location && !matchesRequestedLocation(job.location, filters.location)) return false
    if (filters.salaryMin || filters.salaryMax) {
      const salary = parseSalaryNum(job.salary)
      if (salary && ((filters.salaryMin && salary.max < filters.salaryMin) || (filters.salaryMax && salary.min > filters.salaryMax))) return false
    }
    if (filters.remote && !/(remote|anywhere|worldwide)/i.test(job.location) && !REMOTE_VERIFIED_SOURCES.has(job.source)) {
      const remoteText = `${job.location} ${job.description.slice(0, 150)}`
      const remoteArrangement = job.workArrangement === 'Remote Solely' || job.workArrangement === 'Remote OK'
      if (!/(remote|anywhere|worldwide)/i.test(remoteText) && !remoteArrangement) return false
    }
    return true
  })
}
