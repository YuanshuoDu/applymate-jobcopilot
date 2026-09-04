import { trackedExternalApiFetch } from '@/lib/api-usage/external-api-usage'
import { err, ok } from '@/lib/api-helpers'
import { checkDistributedRateLimit } from '@/lib/distributed-rate-limit'
import { getClientIp } from '@/lib/request-client-ip'
import { notifySupportAdmins } from '@/lib/admin/admin-notifications'
import { getSlaDueAt, sanitizeSupportText } from '@/lib/contact-us'
import { contactEmailConfig, contactEmailPayload, parseContactMessage } from '@/lib/contact-message'
import { db } from '@/lib/db'

const CONTACT_RATE_LIMIT = 5
const CONTACT_RATE_WINDOW_MS = 10 * 60_000

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const message = parseContactMessage(body)
  if ('error' in message) return err(message.error)

  const rateLimit = await checkDistributedRateLimit(`public-contact:${getClientIp(req.headers) ?? 'unknown'}`, CONTACT_RATE_LIMIT, CONTACT_RATE_WINDOW_MS)
  if (!rateLimit.ok) return err(rateLimit.unavailable ? 'Contact service is temporarily unavailable. Please try again later.' : `Too many contact requests. Please retry in ${rateLimit.retryAfter} seconds.`, rateLimit.unavailable ? 503 : 429)

  const requesterName = sanitizeSupportText(message.name)
  const supportMessage = sanitizeSupportText(message.message)
  if (!requesterName || !supportMessage) return err('Invalid contact message')

  let supportCase: { id: string; subject: string; messages: Array<{ id: string }> }
  try {
    supportCase = await db.supportCase.create({
      data: {
        requesterName: requesterName.body,
        requesterEmail: message.email,
        subject: 'Landing page contact',
        category: 'other',
        safeContext: { source: 'landing_contact' },
        slaDueAt: getSlaDueAt('other', 'normal'),
        messages: { create: { authorType: 'customer_reply', body: supportMessage.body, redacted: supportMessage.redacted } },
      },
      select: { id: true, subject: true, messages: { select: { id: true }, orderBy: { createdAt: 'asc' }, take: 1 } },
    })
    const firstMessage = supportCase.messages[0]
    if (firstMessage) await Promise.resolve(notifySupportAdmins({ caseId: supportCase.id, messageId: firstMessage.id, subject: supportCase.subject, event: 'new_case' })).catch(() => undefined)
  } catch {
    return err('We could not create your support case. Please try again.', 503)
  }

  const emailSent = await sendInternalContactEmail(message)
  return ok({ ok: true, caseId: supportCase.id, emailSent }, 201)
}

async function sendInternalContactEmail(message: Parameters<typeof contactEmailPayload>[0]): Promise<boolean> {
  const config = contactEmailConfig()
  if ('error' in config) return false
  try {
    const response = await trackedExternalApiFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(contactEmailPayload(message, config)),
    }, { provider: 'resend', operation: 'contact_email', credentialSource: 'platform' })
    return response.ok
  } catch {
    return false
  }
}
