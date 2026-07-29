import { NextRequest } from 'next/server'
import { err, isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { findGmailConnection } from '@/lib/gmail-helpers'
import { db } from '@/lib/db'
import { matchingCard } from '@/lib/gmail-tracking/recommendation-details'
import { extractRecommendationCards } from '@/lib/gmail-tracking/recommendations'
import { syncGmailForUser } from '@/lib/gmail-tracking/sync'
import { isLikelyJobDetailUrl, recommendationIdentityKey, simplifyRecommendationLocation } from '@/lib/gmail-tracking/recommendation-utils'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const connection = await findGmailConnection(auth.userId)
  if (!connection) return err('NO_GOOGLE_ACCOUNT', 403)

  const sync = await syncGmailForUser(auth.userId)
  if (!sync.connected) return err('GMAIL_REAUTH', 401)
  if (sync.error) return err('GMAIL_ERROR', 502)

  const [messages, recommendations] = await Promise.all([
    db.gmailMessage.findMany({
      where: { userId: auth.userId },
      orderBy: { receivedAt: 'desc' },
      take: 80,
      include: { job: { select: { id: true, company: true, role: true, status: true } } },
    }),
    db.gmailRecommendation.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        sourceMessage: { select: { gmailMessageId: true, gmailThreadId: true, subject: true, excerpt: true, receivedAt: true, senderName: true, senderEmail: true, matchConfidence: true } },
        savedJob: { select: { id: true, company: true, role: true } },
      },
    }),
  ])

  const repairedRecommendations = await Promise.all(recommendations.map(repairRecommendationFromExcerpt))
  const uniqueRecommendations = dedupeRecommendations(repairedRecommendations).map((item) => ({
    ...item,
    location: simplifyRecommendationLocation(item.location),
  }))

  return ok({
    sync,
    messages,
    recommendations: uniqueRecommendations,
    pendingRecommendationCount: uniqueRecommendations.filter((item) => item.status === 'pending').length,
  })
}

type RecommendationRow = { platform: string | null; company: string | null; role: string | null; location: string | null; salary: string | null; url: string | null; description: string | null; status: string }

async function repairRecommendationFromExcerpt<T extends RecommendationRow & { id: string; sourceMessage?: { excerpt: string | null } }>(item: T): Promise<T> {
  if (!item.sourceMessage?.excerpt) return item
  const card = matchingCard(item, extractRecommendationCards({ text: item.sourceMessage.excerpt, platform: item.platform }))
  if (!card) return item
  const patch = {
    company: item.company ?? card.company,
    location: simplifyRecommendationLocation(item.location) ?? simplifyRecommendationLocation(card.location),
    url: isLikelyJobDetailUrl(item.url) ? item.url : card.url ?? item.url,
    description: item.description ?? card.description,
  }
  if (patch.company === item.company && patch.location === item.location && patch.url === item.url && patch.description === item.description) return item
  await db.gmailRecommendation.update({ where: { id: item.id }, data: patch }).catch(() => undefined)
  return { ...item, ...patch }
}

function dedupeRecommendations<T extends RecommendationRow>(items: T[]): T[] {
  const unique: T[] = []
  for (const item of items) {
    const index = unique.findIndex(candidate => sameJob(candidate, item))
    if (index < 0) unique.push(item)
    else if (preference(item) > preference(unique[index])) unique[index] = item
  }
  return unique
}

function sameJob(left: RecommendationRow, right: RecommendationRow): boolean {
  if (isLikelyJobDetailUrl(left.url) && recommendationIdentityKey(left) === recommendationIdentityKey(right)) return true
  if (!sameValue(left.platform, right.platform) || !sameValue(left.role, right.role)) return false
  return compatibleValue(left.company, right.company) && compatibleValue(simplifyRecommendationLocation(left.location), simplifyRecommendationLocation(right.location))
}

function sameValue(left: string | null, right: string | null): boolean {
  return Boolean(left && right && normalise(left) === normalise(right))
}

function compatibleValue(left: string | null, right: string | null): boolean {
  return !left || !right || normalise(left) === normalise(right)
}

function normalise(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function preference(item: RecommendationRow): number {
  const status = item.status === 'saved' ? 100 : item.status === 'pending' ? 50 : 0
  const completeness = [item.company, item.role, item.location, item.url, item.description].filter(Boolean).length
  return status + completeness
}
