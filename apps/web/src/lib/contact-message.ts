export type ContactMessage = {
  name: string
  email: string
  message: string
}

export type ContactEmailConfig = {
  apiKey: string
  from: string
  to: string
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function parseContactMessage(value: unknown): ContactMessage | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Invalid JSON body' }
  const input = value as Record<string, unknown>
  const name = text(input.name)
  const email = text(input.email).toLowerCase()
  const message = text(input.message)
  if (!name || name.length > 120) return { error: 'Name is required and must be at most 120 characters' }
  if (!email || email.length > 320 || !isValidContactEmail(email)) return { error: 'A valid email is required' }
  if (!message || message.length > 4000) return { error: 'Message is required and must be at most 4000 characters' }
  return { name, email, message }
}

export function isValidContactEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value)
}

export function contactEmailConfig(env: NodeJS.ProcessEnv = process.env): ContactEmailConfig | { error: string } {
  const apiKey = env.RESEND_API_KEY?.trim() ?? ''
  const from = env.EMAIL_FROM?.trim() ?? ''
  const to = env.CONTACT_TO_EMAIL?.trim() || env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || 'hello@applymate.ai'
  if (!apiKey || !from) return { error: 'Contact service is not configured. Please email hello@applymate.ai.' }
  return { apiKey, from, to }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character)
}

export function contactEmailPayload(message: ContactMessage, config: ContactEmailConfig) {
  const safeName = escapeHtml(message.name)
  const safeEmail = escapeHtml(message.email)
  const safeMessage = escapeHtml(message.message).replace(/\n/g, '<br />')
  return {
    from: config.from,
    to: [config.to],
    reply_to: message.email,
    subject: `ApplyMate contact form: ${message.name}`,
    text: `Name: ${message.name}\nEmail: ${message.email}\n\n${message.message}`,
    html: `<p><strong>Name:</strong> ${safeName}</p><p><strong>Email:</strong> ${safeEmail}</p><p>${safeMessage}</p>`,
  }
}
