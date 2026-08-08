import { err, ok } from '@/lib/api-helpers'
import { contactEmailConfig, contactEmailPayload, parseContactMessage } from '@/lib/contact-message'

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const message = parseContactMessage(body)
  if ('error' in message) return err(message.error)

  const config = contactEmailConfig()
  if ('error' in config) return err(config.error, 503)

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(contactEmailPayload(message, config)),
    })
    if (!response.ok) return err('We could not send your message. Please try again or email hello@applymate.ai.', 503)
  } catch {
    return err('We could not send your message. Please try again or email hello@applymate.ai.', 503)
  }

  return ok({ ok: true }, 201)
}
