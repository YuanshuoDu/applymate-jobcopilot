export interface RecommendationFingerprintInput {
  platform?: string | null
  company?: string | null
  role?: string | null
  location?: string | null
  url?: string | null
}

/** A stable identifier for retry-safe recommendation persistence. */
export function createRecommendationFingerprint(input: RecommendationFingerprintInput): string {
  const url = canonicalUrl(input.url)
  const identity = url || [input.platform, input.company, input.role, input.location]
    .map(normaliseKey)
    .join('|')
  return `gmail-rec-${hash(identity)}-${hash(`applymate:${identity}`)}`
}

function canonicalUrl(value?: string | null): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|trk|tracking|source|campaign)/i.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    return url.toString().replace(/\/$/, '').toLowerCase()
  } catch {
    return normaliseKey(value)
  }
}

function normaliseKey(value?: string | null): string {
  return (value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function hash(value: string): string {
  let result = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 0x01000193)
  return (result >>> 0).toString(16).padStart(8, '0')
}
