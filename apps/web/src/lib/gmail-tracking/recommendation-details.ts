import { enrichJob } from '@/lib/agent/enrich'
import { fetchGmailMessage } from './gmail-client'
import { extractRecommendationCards, type GmailRecommendationCard } from './recommendations'
import { isLikelyJobDetailUrl, simplifyRecommendationLocation } from './recommendation-utils'

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
export async function hydrateRecommendationDetails(input: SourceRecommendation, accessToken: string): Promise<RecommendationDetails> {
  const source = await fetchGmailMessage(accessToken, input.gmailMessageId).catch(() => null)
  const card = source ? matchingCard(input, extractRecommendationCards({ html: source.html, text: source.text, platform: input.platform })) : null
  const fromEmail = mergeDetails(input, card)
  if (!isLikelyJobDetailUrl(fromEmail.url)) return fromEmail

  try {
    const response = await fetch(fromEmail.url!, {
      cache: 'no-store',
      headers: { 'User-Agent': 'ApplyMate/1.0' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return fromEmail
    const enriched = await enrichJob({ html: await response.text(), url: fromEmail.url! })
    return enriched?.description
      ? { ...fromEmail, description: truncate(enriched.description, 2_000), salary: fromEmail.salary ?? enriched.salary ?? null }
      : fromEmail
  } catch {
    return fromEmail
  }
}

export function matchingCard(input: RecommendationDetails, cards: GmailRecommendationCard[]): GmailRecommendationCard | null {
  const role = normalise(input.role)
  if (!role) return null
  return cards.find(card => normalise(card.role) === role)
    ?? cards.find(card => normalise(card.role).includes(role) || role.includes(normalise(card.role)))
    ?? null
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

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}
