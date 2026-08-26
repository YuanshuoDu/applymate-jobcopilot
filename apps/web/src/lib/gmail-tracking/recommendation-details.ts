import { enrichJob } from '@/lib/agent/enrich'
import { getRuntimeAtsPolicy } from '@/lib/runtime-ats-policy'
import { detectAtsSource } from '@jobcopilot/shared/ats-url'
import { fetchGmailMessage } from './gmail-client'
import { extractRecommendationCards, type GmailRecommendationCard } from './recommendations'
import { isLikelyJobDetailUrl, recommendationIdentityKey, simplifyRecommendationLocation } from './recommendation-utils'
import { fetchExternalText } from '@/lib/safe-outbound-url'

export interface RecommendationDetails {
  platform: string | null
  company: string | null
  role: string | null
  location: string | null
  salary: string | null
  url: string | null
  description: string | null
}

export interface SourceRecommendation extends RecommendationDetails {
  gmailMessageId: string
}

/** Reload the source email before saving so My Jobs receives real job details. */
export async function hydrateRecommendationDetails(input: SourceRecommendation, accessToken: string, userId?: string): Promise<RecommendationDetails> {
  const source = await fetchGmailMessage(accessToken, input.gmailMessageId, userId).catch(() => null)
  const card = source ? matchingCard(input, extractRecommendationCards({ html: source.html, text: source.text, platform: input.platform })) : null
  const fromEmail = mergeDetails(input, card)
  if (!isLikelyJobDetailUrl(fromEmail.url)) return fromEmail

  try {
    const atsSource = detectAtsSource(fromEmail.url!)
    if (atsSource && !(await getRuntimeAtsPolicy(atsSource, userId)).allowed) return fromEmail
    const html = await fetchExternalText(fromEmail.url!, {
      cache: 'no-store',
      headers: { 'User-Agent': 'ApplyMate/1.0' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!html) return fromEmail
    const enriched = await enrichJob({ html, url: fromEmail.url!, userId })
    return enriched?.description
      ? { ...fromEmail, description: truncate(enriched.description, 2_000), salary: fromEmail.salary ?? enriched.salary ?? null }
      : fromEmail
  } catch {
    return fromEmail
  }
}

export function matchingCard(input: RecommendationDetails, cards: GmailRecommendationCard[]): GmailRecommendationCard | null {
  const inputUrlKey = recommendationIdentityKey(input)
  if (inputUrlKey.startsWith('url:')) {
    const urlMatch = cards.find(card => recommendationIdentityKey(card) === inputUrlKey)
    if (urlMatch) return urlMatch
  }
  const role = normalise(input.role)
  if (!role) return null
  const roleMatches = cards.filter(card => normalise(card.role) === role || normalise(card.role).includes(role) || role.includes(normalise(card.role)))
  if (roleMatches.length === 1) return roleMatches[0]
  const contextualMatch = roleMatches.filter(card => compatible(input.company, card.company) && compatible(input.location, card.location))
  return contextualMatch.length === 1 ? contextualMatch[0] : null
}

function mergeDetails(input: RecommendationDetails, card: GmailRecommendationCard | null): RecommendationDetails {
  return {
    platform: card?.platform ?? input.platform,
    company: card?.company ?? input.company,
    role: card?.role ?? input.role,
    location: simplifyRecommendationLocation(card?.location ?? input.location),
    salary: card?.salary ?? input.salary,
    url: card?.url ?? input.url,
    description: card?.description ?? input.description,
  }
}

function normalise(value?: string | null): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function compatible(left: string | null, right: string | null): boolean {
  return Boolean(left && right && normalise(left) === normalise(right))
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}
