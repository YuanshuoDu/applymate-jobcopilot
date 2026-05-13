/**
 * GET /api/gmail/check — verify Gmail access by actually calling the Gmail API.
 * Returns { connected, hasGmail, reason, scopes, gmailError }.
 */
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { getGoogleAccessToken } from '@/lib/gmail-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const account = await db.account.findFirst({
    where: { userId: auth.userId, provider: 'google' },
    select: { access_token: true, scope: true },
  })
  if (!account) return ok({ connected: false, hasGmail: false, reason: 'no_google' })

  const token = await getGoogleAccessToken(auth.userId)
  if (!token) return ok({ connected: true, hasGmail: false, reason: 'token_expired' })

  // 1. Check scopes via tokeninfo (diagnostic)
  let scopes = ''
  try {
    const tiRes = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`)
    if (tiRes.ok) {
      const ti = await tiRes.json()
      scopes = ti.scope ?? ''
    }
  } catch { /* non-critical */ }

  // 2. Actually try a Gmail API call — the authoritative check
  try {
    const gmailRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (gmailRes.ok) {
      return ok({ connected: true, hasGmail: true, scopes, reason: null })
    }

    const errorBody = await gmailRes.text()
    console.error('[gmail/check] Gmail API call failed:', gmailRes.status, errorBody.slice(0, 300))
    console.error('[gmail/check] DB scope:', account.scope ?? '(null)')
    console.error('[gmail/check] Token scopes:', scopes || '(empty)')

    return ok({
      connected: true,
      hasGmail: false,
      reason: gmailRes.status === 403 ? 'scope_missing' : 'gmail_api_error',
      scopes,
      gmailError: errorBody.slice(0, 200),
    })
  } catch (e) {
    console.error('[gmail/check] network error:', e)
    return ok({ connected: true, hasGmail: false, reason: 'check_failed' })
  }
}
