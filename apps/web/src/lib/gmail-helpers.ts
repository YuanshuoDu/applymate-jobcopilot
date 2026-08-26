/**
 * Shared Gmail helpers — token refresh and email body extraction.
 */
import { trackedExternalApiFetch } from '@/lib/api-usage/external-api-usage'
import { db } from '@/lib/db'
import { classifyGmailMessage, type GmailMessageKind } from '@/lib/gmail-tracking'
import { decryptAccountTokens, encryptAccountTokenFields } from '@/lib/credential-secrets'

// ── Token management ─────────────────────────────────────────────────────────

/** Keep Gmail integration credentials separate from Auth.js Google sign-in rows. */
export const GMAIL_ACCOUNT_PROVIDER = 'gmail'

export async function findGmailConnection(userId: string) {
  const select = {
    id: true,
    provider: true,
    providerAccountId: true,
    access_token: true,
    accessTokenEnc: true,
    refresh_token: true,
    refreshTokenEnc: true,
    expires_at: true,
    scope: true,
    token_type: true,
    id_token: true,
    idTokenEnc: true,
    session_state: true,
  } as const

  const connection = await db.account.findFirst({
    where: { userId, provider: GMAIL_ACCOUNT_PROVIDER },
    select,
  })
  if (connection) return decryptAccountTokens(connection)

  // One-time compatibility path for credentials created before Gmail was split
  // from the Auth.js `google` identity provider. Copying preserves login
  // identity and never transfers a connection between users.
  const legacy = await db.account.findFirst({
    where: { userId, provider: 'google', scope: { contains: 'gmail' } },
    select,
  })
  if (!legacy) return null
  const legacyTokens = await decryptAccountTokens(legacy)

  const existingForGoogleAccount = await db.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: GMAIL_ACCOUNT_PROVIDER,
        providerAccountId: legacy.providerAccountId,
      },
    },
    select: { userId: true },
  })
  if (existingForGoogleAccount && existingForGoogleAccount.userId !== userId) return null

  const migrated = await db.account.upsert({
    where: {
      provider_providerAccountId: {
        provider: GMAIL_ACCOUNT_PROVIDER,
        providerAccountId: legacy.providerAccountId,
      },
    },
    create: {
      userId,
      type: 'oauth',
      provider: GMAIL_ACCOUNT_PROVIDER,
      providerAccountId: legacy.providerAccountId,
      ...(await encryptAccountTokenFields({
        provider: GMAIL_ACCOUNT_PROVIDER,
        providerAccountId: legacy.providerAccountId,
        accessToken: legacyTokens.access_token,
        refreshToken: legacyTokens.refresh_token,
        idToken: legacyTokens.id_token,
      })),
      expires_at: legacy.expires_at,
      token_type: legacy.token_type,
      scope: legacy.scope,
      session_state: legacy.session_state,
    },
    update: {},
  })
  return decryptAccountTokens(migrated)
}

export async function getGoogleAccessToken(userId: string): Promise<string | null> {
  const account = await findGmailConnection(userId)
  if (!account?.access_token) {
    console.error('[gmail] getGoogleAccessToken: no access_token in DB for user', userId)
    return null
  }

  const isExpired = account.expires_at ? account.expires_at * 1000 < Date.now() + 60_000 : false
  console.log('[gmail] getGoogleAccessToken: token expires_at=', account.expires_at, 'isExpired=', isExpired, 'hasRefreshToken=', !!account.refresh_token, 'dbScope=', account.scope ?? '(null)')

  if (isExpired) {
    if (!account.refresh_token) {
      console.error('[gmail] token expired and no refresh_token — cannot refresh, returning null')
      return null
    }
    try {
      const res = await trackedExternalApiFetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          client_id:     process.env.AUTH_GOOGLE_ID!,
          client_secret: process.env.AUTH_GOOGLE_SECRET!,
          refresh_token: account.refresh_token,
          grant_type:    'refresh_token',
        }),
      }, { provider: 'google-oauth', operation: 'token_refresh', credentialSource: 'user', userId })
      const data = await res.json()
      console.log('[gmail] token refresh response:', JSON.stringify({ ok: res.ok, status: res.status, hasToken: !!data.access_token, error: data.error }))
      if (data.access_token) {
        await db.account.update({
          where: { id: account.id },
          data:  {
            access_token: null,
            accessTokenEnc: await encryptAccountTokenFields({
              provider: GMAIL_ACCOUNT_PROVIDER,
              providerAccountId: account.providerAccountId,
              accessToken: data.access_token,
            }).then(tokens => tokens.accessTokenEnc),
            expires_at:   Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
          },
        })
        return data.access_token
      }
      console.error('[gmail] refresh returned no access_token, error:', data.error)
      return null
    } catch (e) {
      console.error('[gmail] token refresh failed:', e)
      return null
    }
  }

  return account.access_token
}

// ── Email classification ─────────────────────────────────────────────────────

export function classifyEmail(subject: string, snippet: string): GmailMessageKind {
  return classifyGmailMessage({ subject, excerpt: snippet })
}

// ── MIME body extraction ─────────────────────────────────────────────────────

export function extractPlainText(payload: Record<string, unknown>): string {
  return extractMimeText(payload, 'text/plain')
}

/** Extract the HTML part of a Gmail message for job-digest link parsing. */
export function extractHtml(payload: Record<string, unknown>): string {
  return extractMimeText(payload, 'text/html')
}

function extractMimeText(payload: Record<string, unknown>, expectedMimeType: string): string {
  const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType : ''
  const body = isRecord(payload.body) ? payload.body : undefined
  const direct = mimeType === expectedMimeType || (!mimeType && expectedMimeType === 'text/plain')
  if (direct && typeof body?.data === 'string') return decodeGmailBody(body.data)

  const parts = Array.isArray(payload.parts) ? payload.parts : []
  for (const part of parts) {
    if (!isRecord(part)) continue
    const extracted = extractMimeText(part, expectedMimeType)
    if (extracted) return extracted
  }
  return ''
}

function decodeGmailBody(value: string): string {
  if (!/^[A-Za-z0-9+/\-_=\s]*$/.test(value)) return ''
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    return Buffer.from(normalized, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
