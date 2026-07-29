/** Pure extraction for job-platform recommendation emails. */

import { createRecommendationFingerprint } from './fingerprint'

export { createRecommendationFingerprint } from './fingerprint'
export type { RecommendationFingerprintInput } from './fingerprint'

export interface RecommendationExtractionInput {
  html?: string | null
  text?: string | null
  platform?: string | null
}

export interface GmailRecommendationCard {
  platform: string | null
  company: string | null
  role: string | null
  location: string | null
  salary: string | null
  url: string | null
  description: string | null
  fingerprint: string
}

interface LinkCandidate {
  label: string
  url: string
  context: string
}

const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi
const ANCHOR_PATTERN = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
const HREF_PATTERN = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i
const ROLE_PATTERN = /\b(engineer|developer|designer|manager|analyst|scientist|specialist|consultant|director|lead|intern|associate|architect|researcher|coordinator|administrator|recruiter|writer|product|marketing|sales|operations)\b/i
const GENERIC_LABEL = /^(?:view|view job|view role|view position|apply|apply now|learn more|details|job details|open|see more|read more)$/i
const IGNORED_TEXT = /^(?:unsubscribe|privacy|manage preferences|recommended jobs?|jobs? for you|view in browser)$/i

/**
 * Extracts deduplicated, reviewable cards from HTML or plain-text email
 * content. It never fetches a link or follows a platform redirect.
 */
export function extractRecommendationCards(input: RecommendationExtractionInput): GmailRecommendationCard[] {
  const html = input.html ?? ''
  const text = input.text ?? ''
  const candidates = [...extractHtmlLinks(html), ...extractTextLinks(text)]
  const cards: GmailRecommendationCard[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    const card = parseCandidate(candidate, input.platform)
    if (!card || seen.has(card.fingerprint)) continue
    seen.add(card.fingerprint)
    cards.push(card)
  }

  // Some providers send text-only cards without a separate job URL.
  const textLines = toText(text).split('\n')
  for (const [index, line] of textLines.entries()) {
    if (containsUrl(line) || containsUrl(textLines[index - 1] ?? '') || containsUrl(textLines[index + 1] ?? '')) continue
    const card = parseCandidate({ label: line, context: line, url: '' }, input.platform)
    if (!card || seen.has(card.fingerprint)) continue
    seen.add(card.fingerprint)
    cards.push(card)
  }
  return cards
}

function extractHtmlLinks(html: string): LinkCandidate[] {
  const links: LinkCandidate[] = []
  for (const match of html.matchAll(ANCHOR_PATTERN)) {
    const attributes = match[1] ?? ''
    const href = attributes.match(HREF_PATTERN)
    const url = sanitiseUrl(href?.[1] ?? href?.[2] ?? href?.[3] ?? '')
    if (!url) continue
    const index = match.index ?? 0
    links.push({
      label: toText(match[2] ?? ''),
      url,
      context: htmlContext(html, index),
    })
  }
  return links
}

function extractTextLinks(text: string): LinkCandidate[] {
  const result: LinkCandidate[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    const rawUrl = match[0] ?? ''
    const url = sanitiseUrl(rawUrl)
    if (!url) continue
    const index = match.index ?? 0
    result.push({
      label: '',
      url,
      context: toText(text.slice(Math.max(0, index - 240), Math.min(text.length, index + rawUrl.length + 180))),
    })
  }
  return result
}

function parseCandidate(candidate: LinkCandidate, requestedPlatform?: string | null): GmailRecommendationCard | null {
  const text = toText(`${candidate.label}\n${candidate.context}`)
  if (!isJobLike(candidate, text)) return null
  const parts = text.split('\n').flatMap((line) => [line, ...line.split(/[|·•]/)]).map(clean).filter(Boolean)
  const title = findRoleAndCompany(parts)
  if (!title.role) return null
  const url = sanitiseUrl(candidate.url)
  const platform = clean(requestedPlatform ?? '') || inferPlatform(url, text)
  const card: GmailRecommendationCard = {
    platform: platform || null,
    company: title.company,
    role: title.role,
    location: findLocation(parts, title.role, title.company),
    salary: findSalary(text),
    url: url || null,
    description: findDescription(parts, title.role, title.company),
    fingerprint: '',
  }
  card.fingerprint = createRecommendationFingerprint(card)
  return card
}

function findRoleAndCompany(parts: string[]): { role: string | null; company: string | null } {
  for (const part of parts) {
    const atMatch = part.match(/^(.+?)\s+(?:at|@|with)\s+(.+?)(?:\s+[|·•–—]\s+.*)?$/i)
    if (atMatch && looksLikeRole(atMatch[1])) return { role: clean(atMatch[1]), company: cleanCompany(atMatch[2]) }
    const columns = part.split(/[|·•]/).map(clean).filter(Boolean)
    if (columns.length >= 2 && looksLikeRole(columns[0])) return { role: columns[0], company: cleanCompany(columns[1]) }
  }

  const roleIndex = parts.findIndex(looksLikeRole)
  if (roleIndex < 0) return { role: null, company: null }
  const role = parts[roleIndex]
  const company = parts.slice(roleIndex + 1).find(looksLikeCompany) ?? parts.slice(0, roleIndex).find(looksLikeCompany) ?? null
  return { role, company: company ? cleanCompany(company) : null }
}

function findLocation(parts: string[], role: string, company: string | null): string | null {
  return parts.find((part) => part !== role && part !== company && isLocation(part) && !looksLikeRole(part)) ?? null
}

function findSalary(text: string): string | null {
  return text.match(/(?:€|£|\$|CHF\s*|EUR\s*|GBP\s*|USD\s*)\d[\d.,kK ]*(?:\s*(?:-|–|to)\s*(?:€|£|\$|CHF\s*|EUR\s*|GBP\s*|USD\s*)?\d[\d.,kK ]*)?(?:\s*(?:\/|per\s+)?(?:year|yr|annum|month|hour))?/i)?.[0]?.trim() ?? null
}

function findDescription(parts: string[], role: string, company: string | null): string | null {
  const description = parts.find((part) => part.length > 55 && part !== role && part !== company && !part.includes('http'))
  return description ? description.slice(0, 500) : null
}

function isJobLike(candidate: LinkCandidate, text: string): boolean {
  if (IGNORED_TEXT.test(clean(candidate.label))) return false
  const lowerUrl = candidate.url.toLowerCase()
  return /\b(job|jobs|career|position|posting|vacanc|apply)\b/.test(lowerUrl) || looksLikeRole(text)
}

function looksLikeRole(value: string): boolean {
  const candidate = clean(value)
  return candidate.length >= 3 && candidate.length <= 120 && !GENERIC_LABEL.test(candidate) && ROLE_PATTERN.test(candidate)
}

function looksLikeCompany(value: string): boolean {
  const candidate = clean(value)
  return candidate.length >= 2 && candidate.length <= 80 && !looksLikeRole(candidate) && !GENERIC_LABEL.test(candidate) && !IGNORED_TEXT.test(candidate) && !/^https?:/i.test(candidate) && !/\b(remote|hybrid|on[- ]site)\b/i.test(candidate)
}

function isLocation(value: string): boolean {
  const candidate = clean(value)
  return /\b(remote|hybrid|on[- ]site)\b/i.test(candidate) ||
    /\b(?:Amsterdam|Berlin|Brussels|Copenhagen|Dublin|Helsinki|London|Madrid|Munich|Oslo|Paris|Stockholm|Vienna|Warsaw|Zurich)\b/i.test(candidate) ||
    /^[A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+(?:,\s*[A-Z][A-Za-z .'-]+)?$/.test(candidate)
}

function htmlContext(html: string, index: number): string {
  const prefix = html.slice(0, index)
  for (const tag of ['tr', 'li', 'article']) {
    const open = prefix.lastIndexOf(`<${tag}`)
    const close = html.indexOf(`</${tag}>`, index)
    if (open >= 0 && close >= index && close - open < 2_000) return toText(html.slice(open, close + tag.length + 3))
  }
  return toText(html.slice(Math.max(0, index - 320), Math.min(html.length, index + 480)))
}

function toText(value: string): string {
  return value
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/td|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim()
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/^[\s:|·•–—-]+|[\s:|·•–—-]+$/g, '').trim()
}

function cleanCompany(value: string): string | null {
  const company = clean(value).replace(/\s+(?:in|—|–|-).+$/i, '')
  return looksLikeCompany(company) ? company : null
}

function sanitiseUrl(value: string): string {
  const trimmed = value.replace(/[),.;]+$/, '').trim()
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function containsUrl(value: string): boolean {
  return /https?:\/\/[^\s<>()]+/i.test(value)
}

function inferPlatform(url: string, text: string): string | null {
  const source = `${url} ${text}`.toLowerCase()
  const platforms: Array<[string, string]> = [
    ['linkedin', 'LinkedIn'], ['indeed', 'Indeed'], ['stepstone', 'StepStone'],
    ['xing', 'XING'], ['eures', 'EURES'], ['welcometothejungle', 'Welcome to the Jungle'],
    ['glassdoor', 'Glassdoor'], ['ziprecruiter', 'ZipRecruiter'],
  ]
  return platforms.find(([needle]) => source.includes(needle))?.[1] ?? null
}
