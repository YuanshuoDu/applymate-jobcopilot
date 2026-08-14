/**
 * A stable identity for the same vacancy across a board's list and detail
 * pages.  Display URLs often differ (especially on LinkedIn and Indeed), so
 * using the raw URL would allow the same job to be saved twice.
 */
export type JobIdentityInput = {
  source?: string
  url?: string
  title?: string
  role?: string
  company?: string
  location?: string
}

/**
 * Return true when the URL is only a board/list URL and cannot identify one
 * vacancy by itself.  These URLs need the text fallback so a list card can
 * match its detail-page record after a refresh.
 */
export function isWeakJobIdentity(job: JobIdentityInput): boolean {
  const source = normalise(job.source)
  const url = job.url?.trim() ?? ''
  if (!url) return true
  try {
    const parsed = new URL(url)
    if (source === 'linkedin') {
      return parsed.hash.includes('applymate-card=') || (!parsed.searchParams.get('currentJobId') && !/\/jobs\/view\/(?:[^/?#]*-)?\d{5,}(?:[/?#]|$)/i.test(parsed.pathname))
    }
    if (source === 'indeed') {
      return !parsed.searchParams.get('jk') && !parsed.searchParams.get('vjk')
    }
  } catch {
    return true
  }
  return false
}

/**
 * Compare a scraped job with a saved API record using the same policy across
 * the list injector, detail button, Popup, and Side Panel.
 */
export function isSameJob(left: JobIdentityInput, right: JobIdentityInput): boolean {
  if (getJobIdentity(left) === getJobIdentity(right)) return true

  // Two different strong provider IDs are definitively different postings.
  const leftProvider = getProviderId(normalise(left.source) || 'unknown', left.url?.trim() ?? '')
  const rightProvider = getProviderId(normalise(right.source) || 'unknown', right.url?.trim() ?? '')
  if (leftProvider && rightProvider) return false

  // Never collapse two distinct canonical URLs.  Text matching is only a
  // fallback for weak LinkedIn/Indeed list URLs (or records without a URL).
  if (!isWeakJobIdentity(left) && !isWeakJobIdentity(right)) return false

  const leftSource = normalise(left.source) || 'unknown'
  const rightSource = normalise(right.source) || 'unknown'
  if (leftSource !== rightSource) return false
  if (normalise(left.title ?? left.role) !== normalise(right.title ?? right.role)) return false
  if (normalise(left.company) !== normalise(right.company)) return false
  return locationsOverlap(normalise(left.location), normalise(right.location))
}

export function getJobIdentity(job: JobIdentityInput): string {
  const source = normalise(job.source) || 'unknown'
  const url = job.url?.trim() || ''
  const providerId = getProviderId(source, url)
  if (providerId) return `${source}:${providerId}`

  const canonicalUrl = normaliseUrl(url)
  if (canonicalUrl && !isWeakJobIdentity(job)) return `${source}:url:${canonicalUrl}`

  return `${source}:text:${[job.title ?? job.role, job.company, job.location]
    .map(normalise)
    .filter(Boolean)
    .join('|')}`
}

function getProviderId(source: string, value: string): string | null {
  try {
    const url = new URL(value)
    if (source === 'linkedin') {
      const id = url.hash.includes('applymate-card=') ? null : url.searchParams.get('currentJobId') ||
        url.pathname.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{5,})(?:[/?#]|$)/i)?.[1]
      return id ? `job:${id}` : null
    }
    if (source === 'indeed') {
      const id = url.searchParams.get('jk') || url.searchParams.get('vjk')
      return id ? `job:${id}` : null
    }
  } catch { /* fall back to the canonical URL */ }
  return null
}

function normaliseUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|trk|ref|source|campaign)/i.test(key)) url.searchParams.delete(key)
    }
    return url.href.replace(/\/$/, '')
  } catch {
    return value.trim().toLowerCase().replace(/\/$/, '')
  }
}

function normalise(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function locationsOverlap(left: string, right: string): boolean {
  if (!left || !right || left === 'unknown' || right === 'unknown') return true
  return left.includes(right) || right.includes(left) || left.split(/[(),·|/]+/).some(part =>
    part.trim().length >= 3 && right.includes(part.trim()),
  )
}
