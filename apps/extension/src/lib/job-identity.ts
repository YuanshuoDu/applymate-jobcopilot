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

export function getJobIdentity(job: JobIdentityInput): string {
  const source = normalise(job.source) || 'unknown'
  const url = job.url?.trim() || ''
  const providerId = getProviderId(source, url)
  if (providerId) return `${source}:${providerId}`

  const canonicalUrl = normaliseUrl(url)
  if (canonicalUrl) return `${source}:url:${canonicalUrl}`

  return `${source}:text:${[job.title ?? job.role, job.company, job.location]
    .map(normalise)
    .filter(Boolean)
    .join('|')}`
}

function getProviderId(source: string, value: string): string | null {
  try {
    const url = new URL(value)
    if (source === 'linkedin') {
      const id = url.searchParams.get('currentJobId') ||
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
