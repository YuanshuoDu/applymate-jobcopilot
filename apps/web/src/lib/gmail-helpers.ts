/**
 * Shared Gmail helpers — token refresh and email body extraction.
 */
import { db } from '@/lib/db'

// ── Token management ─────────────────────────────────────────────────────────

export async function getGoogleAccessToken(userId: string): Promise<string | null> {
  const account = await db.account.findFirst({
    where:  { userId, provider: 'google' },
    select: { access_token: true, refresh_token: true, expires_at: true },
  })
  if (!account?.access_token) return null

  const isExpired = account.expires_at ? account.expires_at * 1000 < Date.now() + 60_000 : false

  if (isExpired && account.refresh_token) {
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          client_id:     process.env.AUTH_GOOGLE_ID!,
          client_secret: process.env.AUTH_GOOGLE_SECRET!,
          refresh_token: account.refresh_token,
          grant_type:    'refresh_token',
        }),
      })
      const data = await res.json()
      if (data.access_token) {
        await db.account.updateMany({
          where: { userId, provider: 'google' },
          data:  {
            access_token: data.access_token,
            expires_at:   Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
          },
        })
        return data.access_token
      }
    } catch { /* fall through — return existing token if refresh fails */ }
  }

  return account.access_token
}

// ── Email classification ─────────────────────────────────────────────────────

export function classifyEmail(subject: string, snippet: string): string {
  const t = (subject + ' ' + snippet).toLowerCase()
  if (
    t.includes('congratulations') ||
    (t.includes('offer') && (t.includes('congratulation') || t.includes('pleased') || t.includes('extend'))) ||
    t.includes('offer letter') || t.includes('job offer')
  ) return 'offer'

  if (
    t.includes('unfortunately') || t.includes('regret') || t.includes('not moving forward') ||
    t.includes('unsuccessful') || t.includes('not selected') || t.includes('decided not') ||
    t.includes('other candidates') || t.includes('rejection')
  ) return 'rejected'

  if (
    t.includes('interview') || t.includes('technical assessment') || t.includes('coding challenge') ||
    t.includes('take-home') || t.includes('schedule a call') || t.includes('next step') ||
    t.includes('video call') || t.includes('phone screen') || t.includes('invite you')
  ) return 'interview'

  if (
    t.includes('thank you for applying') || t.includes('application received') ||
    t.includes('we have received') || t.includes('confirm your application')
  ) return 'received'

  if (t.includes('viewed your profile') || t.includes('viewed your application')) return 'viewed'

  return 'received'
}

// ── MIME body extraction ─────────────────────────────────────────────────────

export function extractPlainText(payload: Record<string, unknown>): string {
  const body = payload.body as Record<string, unknown> | undefined
  if (body?.data && typeof body.data === 'string') {
    if (!/^[A-Za-z0-9+/\-_=\s]*$/.test(body.data)) return ''
    try { return Buffer.from(body.data, 'base64').toString('utf-8') } catch { return '' }
  }
  const parts = payload.parts as Record<string, unknown>[] | undefined
  if (parts) {
    for (const part of parts) {
      if ((part.mimeType as string) === 'text/plain') {
        const pb = part.body as Record<string, unknown> | undefined
        if (pb?.data) {
          try { return Buffer.from(pb.data as string, 'base64').toString('utf-8') } catch { return '' }
        }
      }
      if (part.parts) {
        const nested = extractPlainText(part as Record<string, unknown>)
        if (nested) return nested
      }
    }
  }
  return ''
}
