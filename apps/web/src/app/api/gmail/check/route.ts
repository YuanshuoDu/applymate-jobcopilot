/**
 * GET /api/gmail/check — verify Gmail access by actually calling the Gmail API.
 * Returns { connected, hasGmail, reason, scopes, gmailError }.
 */
import { trackedExternalApiFetch } from '@/lib/api-usage/external-api-usage'
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { findGmailConnection, getGoogleAccessToken } from '@/lib/gmail-helpers'
import { aiUsageErrorCode } from '@/lib/ai-usage'

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
  const gmailRes = await trackedExternalApiFetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      { headers: { Authorization: `Bearer ${token}` } },
      { provider: 'gmail', operation: 'profile', credentialSource: 'user', userId: auth.userId },
    )
    if (gmailRes.ok) {
      return ok({ connected: true, hasGmail: true, scopes, reason: null })
    }

    const errorCode = aiUsageErrorCode(new Error(`HTTP ${gmailRes.status}`))
    console.error('[gmail/check] Gmail API call failed', { status: gmailRes.status, errorCode })
    console.error('[gmail/check] DB scope:', account.scope ?? '(null)')
    console.error('[gmail/check] Token scopes:', scopes || '(empty)')

    return ok({
      connected: true,
      hasGmail: false,
      reason: gmailRes.status === 403 ? 'scope_missing' : 'gmail_api_error',
      scopes,
      gmailError: gmailRes.status === 403 ? 'scope_missing' : errorCode,
    })
  } catch (e) {
    console.error('[gmail/check] network error', { errorCode: aiUsageErrorCode(e) })
    return ok({ connected: true, hasGmail: false, reason: 'check_failed' })
  }
}
