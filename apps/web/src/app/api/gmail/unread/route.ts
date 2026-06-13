/**
 * GET /api/gmail/unread — lightweight endpoint returning unread count for sidebar badge
 */
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { getGoogleAccessToken } from '@/lib/gmail-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const account = await db.account.findFirst({
    where: { userId: auth.userId, provider: 'google' },
    select: { access_token: true },
  })
  if (!account) return ok({ unread: 0, hasGmail: false })

  const token = await getGoogleAccessToken(auth.userId)
  if (!token) return ok({ unread: 0, hasGmail: false })

  try {
    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=is:unread',
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) return ok({ unread: 0, hasGmail: false })
    const data = await res.json()
    return ok({ unread: data.resultSizeEstimate ?? 0, hasGmail: true })
  } catch {
    return ok({ unread: 0, hasGmail: false })
  }
}
