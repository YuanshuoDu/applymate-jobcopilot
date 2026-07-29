import { NextRequest } from 'next/server'
import { err, isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { findGmailConnection } from '@/lib/gmail-helpers'
import { db } from '@/lib/db'
import { syncGmailForUser } from '@/lib/gmail-tracking/sync'

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
        sourceMessage: { select: { subject: true, receivedAt: true } },
        savedJob: { select: { id: true, company: true, role: true } },
      },
    }),
  ])

  return ok({
    sync,
    messages,
    recommendations,
    pendingRecommendationCount: recommendations.filter((item) => item.status === 'pending').length,
  })
}
