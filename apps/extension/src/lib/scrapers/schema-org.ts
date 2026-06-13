import type { ScrapedJob } from '../types'

/**
 * Parse JSON-LD / Microdata from the page to extract JobPosting structured data.
 * Many job sites (LinkedIn, Indeed, Greenhouse, Lever, etc.) embed schema.org markup.
 * This is the most reliable extraction method when available.
 */
export function scrapeSchemaOrg(): ScrapedJob | null {
  // Try JSON-LD first (most common)
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? '{}')
      const job = extractFromJsonLd(data)
      if (job) return job
    } catch { /* invalid JSON, skip */ }
  }

  // Try meta tags as fallback
  const metaTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content?.trim()
  const metaDesc  = document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content?.trim()
  const metaCompany = document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content?.trim()

  if (metaTitle && metaCompany) {
    return {
      title:       metaTitle,
      company:     metaCompany,
      location:    'Unknown',
      description: metaDesc ?? '',
      salary:      null,
      url:         window.location.href,
      source:      'unknown',
    }
  }

  return null
}

function extractFromJsonLd(data: unknown): ScrapedJob | null {
  if (!data || typeof data !== 'object') return null

  const obj = data as Record<string, unknown>

  // Handle @graph array (multiple entities)
  if (Array.isArray(obj['@graph'])) {
    for (const item of obj['@graph']) {
      const job = extractFromJsonLd(item)
      if (job) return job
    }
    return null
  }

  // Only extract JobPosting type
  const type = obj['@type']
  if (type !== 'JobPosting' && !(typeof type === 'string' && type.includes('JobPosting'))) {
    return null
  }

  const title = stringOrNull(obj, 'title')
  const description = stringOrNull(obj, 'description') ?? ''

  // HiringOrganization can be an object or string
  const org = obj['hiringOrganization'] as Record<string, unknown> | undefined
  const company = typeof org === 'string'
    ? org
    : stringOrNull(org ?? {}, 'name')

  // JobLocation can be an object or string
  const loc = obj['jobLocation'] as Record<string, unknown> | undefined
  const address = loc?.['address'] as Record<string, unknown> | undefined
  const location = typeof loc === 'string'
    ? loc
    : stringOrNull(address ?? {}, 'addressLocality') ??
      stringOrNull(address ?? {}, 'addressRegion') ??
      stringOrNull(loc ?? {}, 'name') ??
      'Unknown'

  // BaseSalary
  const baseSalary = obj['baseSalary'] as Record<string, unknown> | undefined
  const salaryMin  = baseSalary?.['value'] ?? baseSalary?.['minValue']
  const salaryMax  = baseSalary?.['maxValue']
  const salaryCur  = baseSalary?.['currency']
  const salary = salaryMin
    ? `${salaryCur ?? 'EUR'} ${salaryMin}${salaryMax ? ` - ${salaryMax}` : ''}`
    : null

  if (!title || !company) return null

  return {
    title,
    company,
    location,
    description: stripHtml(description),
    salary,
    url:         stringOrNull(obj, 'url') ?? window.location.href,
    source:      'unknown',
  }
}

function stringOrNull(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}
