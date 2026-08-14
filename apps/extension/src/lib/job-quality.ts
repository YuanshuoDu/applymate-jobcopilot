import type { ScrapedJob } from './types'

export const MIN_JOB_DESCRIPTION_LENGTH = 80

type JobLike = Pick<ScrapedJob, 'title' | 'company' | 'location' | 'description' | 'salary' | 'url' | 'source'>

export function hasUsableDescription(description: string | null | undefined): boolean {
  return typeof description === 'string' && description.replace(/\s+/g, ' ').trim().length >= MIN_JOB_DESCRIPTION_LENGTH
}

export function hasKnownLocation(location: string | null | undefined): boolean {
  if (typeof location !== 'string') return false
  const value = location.trim()
  return Boolean(value) && !/^(unknown|n\/?a|not specified|none)$/i.test(value)
}

export function isJobReadyForTailoring(job: Pick<JobLike, 'description' | 'location' | 'source'>): boolean {
  if (!hasUsableDescription(job.description)) return false
  // LinkedIn and Indeed visibly expose a location in their detail panes.
  // Treating a missing location as ready there only hides a scraper failure.
  return !['linkedin', 'indeed'].includes(job.source) || hasKnownLocation(job.location)
}

export function canonicalJobKey(job: Pick<JobLike, 'source' | 'url'>): string | null {
  const source = job.source.toLowerCase()
  try {
    const url = new URL(job.url)
    if (source === 'linkedin') {
      const id = url.searchParams.get('currentJobId') || url.pathname.match(/\/jobs\/view\/(\d+)/i)?.[1]
      return id ? `linkedin:${id}` : null
    }
    if (source === 'indeed') {
      const id = url.searchParams.get('jk') || url.searchParams.get('vjk')
      return id ? `indeed:${id}` : null
    }
    return `${source}:${url.origin}${url.pathname}${url.search}`
  } catch {
    return null
  }
}

export function sameCanonicalJob(a: Pick<JobLike, 'source' | 'url'>, b: Pick<JobLike, 'source' | 'url'>): boolean {
  const left = canonicalJobKey(a)
  const right = canonicalJobKey(b)
  return Boolean(left && right && left === right)
}

export function mergeJobDetails<T extends JobLike>(primary: T, fallback: Partial<JobLike> | null | undefined): T {
  if (!fallback) return primary
  const fallbackDescription = fallback.description ?? ''
  const primaryDescription = primary.description ?? ''
  const useFallbackDescription = fallbackDescription.trim().length > primaryDescription.trim().length
  const useFallbackLocation = !hasKnownLocation(primary.location) && hasKnownLocation(fallback.location)
  const useFallbackSalary = !primary.salary && Boolean(fallback.salary)
  const fallbackCanonical = fallback.url
    ? canonicalJobKey({ source: fallback.source ?? primary.source, url: fallback.url })
    : null
  const useFallbackUrl = Boolean(fallback.url && fallbackCanonical && !canonicalJobKey(primary))

  return {
    ...primary,
    url: useFallbackUrl ? fallback.url! : primary.url,
    description: useFallbackDescription ? fallbackDescription : primary.description,
    location: useFallbackLocation ? fallback.location! : primary.location,
    salary: useFallbackSalary ? fallback.salary! : primary.salary,
  }
}
