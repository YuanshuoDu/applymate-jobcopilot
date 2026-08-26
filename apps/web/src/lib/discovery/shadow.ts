export type ShadowJobEvidence = {
  url: string
  title?: string | null
  company?: string | null
  description?: string | null
}

export type ShadowComparison = {
  shadowJobs: number
  netNewJobs: number
  validApplyUrls: number
  completeDescriptions: number
}

const TRACKING_PARAMS = /^(utm_|ref$|source$|src$|trk$|origin$|referer$|viewid$|trackingid$|sid$|cid$)/i

export function canonicalJobKey(url: string): string {
  try {
    const parsed = new URL(url.trim())
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key)
    parsed.searchParams.sort()
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`.toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

function validApplyUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function completeDescription(description: string | null | undefined): boolean {
  return Boolean(description?.trim() && description.trim().length >= 80)
}

export function compareShadowJobs(visible: readonly ShadowJobEvidence[], shadow: readonly ShadowJobEvidence[]): ShadowComparison {
  const visibleKeys = new Set(visible.map(job => canonicalJobKey(job.url)).filter(Boolean))
  const uniqueShadow = new Map<string, ShadowJobEvidence>()
  for (const job of shadow) {
    const key = canonicalJobKey(job.url)
    if (key) uniqueShadow.set(key, job)
  }
  const values = [...uniqueShadow.entries()]
  return {
    shadowJobs: values.length,
    netNewJobs: values.filter(([key]) => !visibleKeys.has(key)).length,
    validApplyUrls: values.filter(([, job]) => validApplyUrl(job.url)).length,
    completeDescriptions: values.filter(([, job]) => completeDescription(job.description)).length,
  }
}
