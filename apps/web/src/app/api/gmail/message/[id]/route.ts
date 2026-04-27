/**
 * GET /api/gmail/message/:id
 * Returns the plain-text body of a single Gmail message.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { getGoogleAccessToken, extractPlainText } from '@/lib/gmail-helpers'

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id }  = await params
  const token   = await getGoogleAccessToken(auth.userId)
  if (!token) return err('No Google account connected', 403)

  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!res.ok) return err('Gmail API error', res.status as 400 | 500)

    const msg  = await res.json()
    const body = extractPlainText(msg.payload ?? {})

    return ok({ id, body: body.trim() })
  } catch (e) {
    console.error('[/api/gmail/message] error:', e)
    return err('Failed to fetch message', 500)
  }
}
