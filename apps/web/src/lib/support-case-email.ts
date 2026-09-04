import { trackedExternalApiFetch } from '@/lib/api-usage/external-api-usage'
import { contactEmailConfig, escapeHtml, isValidContactEmail } from './contact-message'

export async function sendSupportCaseReplyEmail(input: { recipient: string; subject: string; body: string }): Promise<boolean> {
  if (!isValidContactEmail(input.recipient)) return false
  const config = contactEmailConfig()
  if ('error' in config) return false
  const safeSubject = escapeHtml(input.subject)
  const safeBody = escapeHtml(input.body).replace(/\n/g, '<br />')
  try {
    const response = await trackedExternalApiFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.from,
        to: [input.recipient],
        reply_to: config.to,
        subject: `Re: ${input.subject}`,
        text: `The ApplyMate support team replied to your case: ${input.subject}\n\n${input.body}`,
        html: `<p>The ApplyMate support team replied to your case: <strong>${safeSubject}</strong></p><p>${safeBody}</p>`,
      }),
    }, { provider: 'resend', operation: 'support_case_reply_email', credentialSource: 'platform' })
    return response.ok
  } catch {
    return false
  }
}
