export interface RecommendationIdentityInput {
  platform?: string | null
  company?: string | null
  role?: string | null
  location?: string | null
  url?: string | null
}

const PLACE_PATTERN = /\b(Amsterdam|Berlin|Brussels|Copenhagen|Dublin|Helsinki|London|Madrid|Munich|Oslo|Paris|Stockholm|Vienna|Warsaw|Zurich)(?:,\s*(?:County\s+)?[A-Za-z .'-]+)?\b/gi

export function simplifyRecommendationLocation(value?: string | null): string | null {
  const input = value?.replace(/\s+/g, ' ').trim()
  if (!input) return null
  const remote = input.match(/\b(remote|hybrid|on[- ]site)\b/i)?.[1]
  if (remote) return remote.replace(/^./, letter => letter.toUpperCase()).replace(/[- ]site/i, 'site')
  const matches = [...input.matchAll(PLACE_PATTERN)].map(match => match[0])
  const place = matches.find(match => match.includes(',')) ?? matches.at(-1)
  return place?.replace(/\s+/g, ' ').trim() ?? null
}

/** Same job alert repeated in different emails should resolve to one identity. */
export function recommendationIdentityKey(input: RecommendationIdentityInput): string {
  const directUrl = canonicalJobUrl(input.url)
  if (directUrl) return `url:${directUrl}`
  return recommendationSemanticKey(input) ?? 'job:unknown'
}

/** Prefer the stable job facts over an email redirect when grouping alerts. */
export function recommendationSemanticKey(input: RecommendationIdentityInput): string | null {
  if (!input.company || !input.role) return null
  const fields = [input.platform, input.company, input.role, simplifyRecommendationLocation(input.location)]
    .map(normalise)
  return `job:${fields.join('|')}`
}

export function isLikelyJobDetailUrl(value?: string | null): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (host.includes('indeed.')) return Boolean(url.searchParams.get('jk') || url.searchParams.get('vjk'))
    if (host.includes('linkedin.')) return /\/jobs\/view\//i.test(url.pathname)
    return /(greenhouse\.io|lever\.co|myworkdayjobs\.com|smartrecruiters\.com|personio\.de)/i.test(host)
  } catch {
    return false
  }
}

function canonicalJobUrl(value?: string | null): string | null {
  if (!isLikelyJobDetailUrl(value)) return null
  try {
    const url = new URL(value!)
    const host = url.hostname.toLowerCase()
    if (host.includes('indeed.')) return `indeed:${url.searchParams.get('jk') || url.searchParams.get('vjk')}`
    if (host.includes('linkedin.')) return `linkedin:${url.pathname.match(/\/(\d{5,})\/?$/)?.[1] ?? url.pathname}`
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|trk|ref|source|campaign)/i.test(key)) url.searchParams.delete(key)
    return url.toString().toLowerCase()
  } catch {
    return null
  }
}

function normalise(value?: string | null): string {
  return (value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}
