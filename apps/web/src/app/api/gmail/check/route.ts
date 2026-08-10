/**
 * GET /api/gmail/check — verify Gmail access by actually calling the Gmail API.
 * Returns { connected, hasGmail, reason, scopes, gmailError }.
 */
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { findGmailConnection, getGoogleAccessToken } from '@/lib/gmail-helpers'

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const account = await findGmailConnection(auth.userId)
  if (!account) return ok({ connected: false, hasGmail: false, reason: 'no_google' })

  const token = await getGoogleAccessToken(auth.userId)
  if (!token) return ok({ connected: true, hasGmail: false, reason: 'token_expired' })

  // Keep the diagnostic scope from the stored OAuth metadata. Access tokens
  // must never be placed in a URL query string where proxies can log them.
  const scopes = account.scope ?? ''

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
