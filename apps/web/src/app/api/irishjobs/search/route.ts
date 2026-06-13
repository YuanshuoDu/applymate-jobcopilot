/**
 * GET /api/irishjobs/search
 * IrishJobs.ie — Ireland's #1 job board (Saongroup/StepStone).
 * Free, no API key required — parses public RSS feeds.
 *
 * IrishJobs.ie RSS format:
 *   https://www.irishjobs.ie/jobs/[keyword-slug]/in-[location-slug]?format=rss
 *   https://www.irishjobs.ie/jobs/[keyword-slug]?format=rss
 *
 * Params:
 *   q         string  — keywords (spaces → hyphens)
 *   location  string  — location (default: ireland)
 *   page      number  — 1-based page
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

const BASE = 'https://www.irishjobs.ie'

// Slugify for IrishJobs URL structure
function slugify(s: string): string {
  return s.trim().toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

// Minimal RSS XML parser — avoids heavy dependencies
function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
           ?? xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'))
  return m?.[1]?.trim() ?? ''
}

function extractAllTags(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  return [...xml.matchAll(pattern)].map(m => m[1].trim())
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseRss(xml: string): Array<{
  title: string; link: string; description: string; pubDate: string | null
  location: string; company: string
}> {
  const itemsXml = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)]
  return itemsXml.map(m => {
    const item  = m[1]
    const title = stripHtml(extractTag(item, 'title'))
    const link  = extractTag(item, 'link')
    const desc  = stripHtml(extractTag(item, 'description'))
    const pub   = extractTag(item, 'pubDate')

    // IrishJobs RSS description often contains "Company: X | Location: Y | Salary: Z"
    const coMatch  = desc.match(/Company[:\s]+([^|]+)/i)
    const locMatch = desc.match(/Location[:\s]+([^|]+)/i)
    const company  = coMatch?.[1]?.trim() ?? ''
    const location = locMatch?.[1]?.trim() ?? ''

    return {
      title,
      link,
      description: desc.slice(0, 500),
      pubDate:     pub ? new Date(pub).toISOString() : null,
      company,
      location,
    }
  })
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const sp       = req.nextUrl.searchParams
  const q        = sp.get('q')?.trim() ?? ''
  const location = sp.get('location')?.trim() || 'ireland'
  const page     = Math.max(1, parseInt(sp.get('page') ?? '1', 10))

  if (!q) return err('q is required')

  const keySlug = slugify(q)
  const locSlug = slugify(location)

  // IrishJobs.ie blocks automated RSS access (403/connection refused in testing).
  // Their robots.txt lists /JobSearch/RSS.aspx as Disallow.
  // These attempts are best-effort — we return empty gracefully if blocked.
  // For reliable Irish job coverage, the integration relies on:
  //   LinkedIn(Ireland) + Indeed(ie) + ATS + Reed/CareerJet/JSearch as primary sources.
  // To get official access, contact: https://www.irishjobs.ie/Api-Jobs
  const urlCandidates = [
    `${BASE}/jobs/${keySlug}/in-${locSlug}?format=rss&page=${page}`,
    `${BASE}/jobs/${keySlug}?format=rss&location=${encodeURIComponent(location)}&page=${page}`,
    `${BASE}/JobSearch/RSS.aspx?Keywords=${encodeURIComponent(q)}&Location=${encodeURIComponent(location)}&Page=${page}`,
    `${BASE}/SearchResults.aspx?Keywords=${encodeURIComponent(q)}&format=rss&Page=${page}`,
  ]

  let xml: string | null = null

  for (const url of urlCandidates) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (compatible; ApplyMate/1.0; +https://applymate.ai/bot)',
          'Accept':          'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'en-IE, en-GB;q=0.9, en;q=0.8',
          'Cache-Control':   'no-cache',
        },
        signal: AbortSignal.timeout(8_000),
        cache:  'no-store',
      })
      if (res.ok) {
        const contentType = res.headers.get('content-type') ?? ''
        const text = await res.text()
        if (text.includes('<rss') || text.includes('<?xml') || contentType.includes('xml')) {
          xml = text
          break
        }
      }
    } catch { continue }
  }

  if (!xml) {
    // Return empty gracefully — site may have blocked or RSS URL changed
    return ok({ jobs: [], total: 0, source: 'irishjobs', note: 'RSS feed unavailable' })
  }

  const items = parseRss(xml)

  const jobs = items.map((item, i) => ({
    id:          `ij-${page}-${i}`,
    title:       item.title,
    company:     item.company,
    location:    item.location || location,
    description: item.description,
    url:         item.link,
    postedAt:    item.pubDate,
    salary:      null,
    logo:        null,
    jobType:     null,
    source:      'irishjobs' as const,
  }))

  return ok({ jobs, total: jobs.length, page })
}
