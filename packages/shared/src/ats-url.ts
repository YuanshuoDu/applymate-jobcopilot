import type { AtsSourceKey } from './ats-policy.js'

export type { AtsSourceKey } from './ats-policy.js'

/**
 * Classify direct application URLs supported by the unattended Worker.
 * Vendor marketing domains deliberately do not count as application links.
 */
export function detectAtsSource(rawUrl: string): AtsSourceKey | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)
  const isGreenhouseEmbeddedApplication =
    host.startsWith('job-boards.') &&
    host.endsWith('.greenhouse.io') &&
    segments.length === 2 &&
    segments[0] === 'embed' &&
    segments[1] === 'job_app' &&
    url.searchParams.has('for')

  if (
    (host === 'boards.greenhouse.io' && segments.length >= 3 && segments[1] === 'jobs') ||
    (host.endsWith('.greenhouse.io') && host !== 'boards.greenhouse.io' && segments.length >= 2 && segments[0] === 'jobs') ||
    isGreenhouseEmbeddedApplication ||
    (host === 'greenhouse.io' && segments.length >= 2 && segments[0] === 'applications')
  ) return 'greenhouse'

  if (
    ((host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') && segments.length >= 2) ||
    (host === 'app.lever.co' && segments.length >= 3 && segments[0] === 'posting')
  ) return 'lever'

  if (
    (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') &&
    segments.length >= 2
  ) return 'smartrecruiters'

  if (host.endsWith('.myworkdayjobs.com') && segments.length >= 1) return 'workday'
  if (host.endsWith('.jobs.personio.com') && segments.length >= 1) return 'personio'
  return null
}
