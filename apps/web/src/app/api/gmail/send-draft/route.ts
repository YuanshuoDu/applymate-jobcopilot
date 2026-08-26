/**
 * POST /api/gmail/send-draft
 * Sends a user-confirmed follow-up via Gmail and records it against a matched job.
 * Body: { to, subject, draft, gmailMessageId?, threadId?, jobId? }
 */
import { NextRequest }                          from 'next/server'
import { trackedExternalApiFetch }                from '@/lib/api-usage/external-api-usage'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { getGoogleAccessToken }                  from '@/lib/gmail-helpers'
import { db }                                    from '@/lib/db'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body?.to || !body?.draft) return err('Missing to or draft')

  const { to, subject, draft, jobId, gmailMessageId, threadId, messageKind } = body as {
    to: string; subject: string; draft: string; jobId?: string; gmailMessageId?: string; threadId?: string; messageKind?: string
  }

  const token = await getGoogleAccessToken(auth.userId)
  if (!token) return err('Gmail not connected. Please connect Google account in Settings.')

  // Build RFC 2822 message
  const fromRes = await trackedExternalApiFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${token}` },
  }, { provider: 'gmail', operation: 'profile', credentialSource: 'user', userId: auth.userId })
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

  const sendRes = await trackedExternalApiFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ raw, ...(typeof threadId === 'string' && threadId ? { threadId } : {}) }),
  }, { provider: 'gmail', operation: 'send_message', credentialSource: 'user', userId: auth.userId })

  if (!sendRes.ok) {
    return err(`Gmail send failed (HTTP ${sendRes.status})`, 500)
  }

  const matchedJob = await findFollowUpJob(auth.userId, jobId, gmailMessageId)
  if (matchedJob) await db.$transaction(async tx => {
    await tx.job.update({ where: { id: matchedJob.id }, data: { followUpAt: null } })
    await tx.activity.create({
      data: {
        userId: auth.userId,
        jobId: matchedJob.id,
        type: 'email_sent',
        text: `Follow-up email sent to ${to}${messageKind ? ` · ${messageKind.replace(/_/g, ' ')}` : ''}`,
        color: '#7C3AED',
      },
    })
  })

  return ok({ sent: true, to, tracked: Boolean(matchedJob), jobId: matchedJob?.id ?? null })
}

async function findFollowUpJob(userId: string, requestedJobId: unknown, gmailMessageId: unknown) {
  if (typeof requestedJobId === 'string' && requestedJobId) {
    return db.job.findFirst({ where: { id: requestedJobId, userId }, select: { id: true } })
  }
  if (typeof gmailMessageId !== 'string' || !gmailMessageId) return null
  const message = await db.gmailMessage.findFirst({
    where: { userId, gmailMessageId, jobId: { not: null } },
    select: { job: { select: { id: true } } },
  })
  return message?.job ?? null
}
