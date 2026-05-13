/**
 * GET /api/gmail/threads
 *
 * Fetches job-related emails from Gmail for the signed-in user.
 * Requires the user to have signed in with Google (gmail.readonly scope).
 *
 * Error codes in response body:
 *   NO_GOOGLE_ACCOUNT   — user hasn't signed in with Google
 *   TOKEN_EXPIRED       — access token expired AND refresh failed
 *   GMAIL_REAUTH        — token lacks gmail scope; old account wiped, re-auth needed
 *   GMAIL_ERROR         — other Gmail API error
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { getGoogleAccessToken, classifyEmail } from '@/lib/gmail-helpers'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  console.log('[gmail/threads] === /api/gmail/threads called, userId=', auth.userId)

  // 1. Check Google account exists
  const account = await db.account.findFirst({
    where:  { userId: auth.userId, provider: 'google' },
    select: { access_token: true },
  })
  if (!account) {
    console.error('[gmail/threads] no Google account in DB → NO_GOOGLE_ACCOUNT')
    return err('NO_GOOGLE_ACCOUNT', 403)
  }
  console.log('[gmail/threads] Google account exists in DB')

  // 2. Get fresh access token (auto-refreshes if needed)
  const accessToken = await getGoogleAccessToken(auth.userId)
  if (!accessToken) {
    console.error('[gmail/threads] getGoogleAccessToken returned null → GMAIL_REAUTH (token expired/missing)')
    return err('GMAIL_REAUTH', 401)
  }
  console.log('[gmail/threads] got access token, length=', accessToken.length)

  // 3. Fetch Gmail messages
  try {
    const q = encodeURIComponent(
      'subject:(application OR interview OR offer OR "thank you for applying" OR "your application" OR "position" OR "candidacy" OR "hiring" OR "opportunity") -from:me'
    )
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=${q}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )

    console.log('[gmail/threads] Gmail API response status:', listRes.status)

    if (!listRes.ok) {
      if (listRes.status === 401) {
        console.error('[gmail/threads] Gmail returned 401 → TOKEN_EXPIRED')
        return err('TOKEN_EXPIRED', 401)
      }
      if (listRes.status === 403) {
        const errorBody = await listRes.text()
        console.error('[gmail/threads] Gmail returned 403 → GMAIL_SCOPE_MISSING. Body:', errorBody.slice(0, 200))
        return err('GMAIL_SCOPE_MISSING', 403)
      }
      console.error('[gmail/threads] Gmail API unexpected error:', listRes.status)
      return err('GMAIL_ERROR', 500)
    }

    console.log('[gmail/threads] Gmail API call SUCCESS — fetching messages')

    const listData = await listRes.json()
    const messages: { id: string }[] = listData.messages ?? []

    if (messages.length === 0) return ok({ emails: [], hasGmail: true })

    // 4. Fetch metadata for each message (parallel)
    const details = await Promise.allSettled(
      messages.slice(0, 20).map(msg =>
        fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata` +
          `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        ).then(r => r.ok ? r.json() : null)
      )
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emails = details
      .filter((d): d is PromiseFulfilledResult<any> => d.status === 'fulfilled' && d.value !== null)
      .map(d => {
        const msg     = d.value
        const headers = (msg.payload?.headers ?? []) as { name: string; value: string }[]
        const get     = (name: string) => headers.find(h => h.name === name)?.value ?? ''

        const rawFrom  = get('From')
        const subject  = get('Subject')
        const date     = get('Date')
        const snippet  = (msg.snippet as string) ?? ''
        const labels   = (msg.labelIds as string[]) ?? []

        const nameMatch = rawFrom.match(/^"?(.+?)"?\s*<(.+?)>$/)
        const senderName  = nameMatch ? nameMatch[1].trim() : rawFrom
        const senderEmail = nameMatch ? nameMatch[2] : rawFrom

        return {
          id:       msg.id as string,
          threadId: msg.threadId as string,
          from:     senderEmail,
          name:     senderName,
          subject,
          preview:  snippet,
          date,
          tag:      classifyEmail(subject, snippet),
          read:     !labels.includes('UNREAD'),
          starred:  labels.includes('STARRED'),
        }
      })

    return ok({ emails, hasGmail: true })
  } catch (e) {
    console.error('[/api/gmail/threads] error:', e)
    return err('GMAIL_ERROR', 500)
  }
}
