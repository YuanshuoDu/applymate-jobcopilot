/**
 * GET /api/gmail/unread — returns actionable Gmail recommendation count for
 * the sidebar badge. Raw inbox unread counts are not a reliable job signal.
 */
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { findGmailConnection } from '@/lib/gmail-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const account = await findGmailConnection(auth.userId)
  if (!account) return ok({ unread: 0, hasGmail: false })

  const pendingRecommendations = await db.gmailRecommendation.count({
    where: { userId: auth.userId, status: 'pending' },
  }).catch(() => 0)
  return ok({ unread: pendingRecommendations, pendingRecommendations, hasGmail: true })
}
