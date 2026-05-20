/**
 * POST /api/gmail/send-draft
 * Sends a pre-drafted email via Gmail API (user-confirmed rejection follow-up).
 * Body: { to, subject, draft, jobId }
 */
import { NextRequest }                          from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { getGoogleAccessToken }                  from '@/lib/gmail-helpers'
import { db }                                    from '@/lib/db'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body?.to || !body?.draft) return err('Missing to or draft')

  const { to, subject, draft, jobId } = body as {
    to: string; subject: string; draft: string; jobId?: string
  }

  const token = await getGoogleAccessToken(auth.userId)
  if (!token) return err('Gmail not connected. Please connect Google account in Settings.')

  // Build RFC 2822 message
  const fromRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const profile = fromRes.ok ? await fromRes.json() as { emailAddress?: string } : {}
  const from = profile.emailAddress ?? 'me'

  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject ?? 'Following up on my application'}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    draft,
  ]
  const raw = Buffer.from(messageParts.join('\r\n')).toString('base64url')

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ raw }),
  })

  if (!sendRes.ok) {
    const errText = await sendRes.text()
    return err(`Gmail send failed: ${errText}`, 500)
  }

  // Log the send
  if (jobId) {
    await db.activity.create({
      data: {
        userId: auth.userId,
        jobId,
        type:   'agent_action',
        text:   `拒信问询邮件已发送至 ${to}`,
        color:  '#7C3AED',
      },
    }).catch(() => {})
  }

  return ok({ sent: true, to })
}
