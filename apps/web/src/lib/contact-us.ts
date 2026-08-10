export const SUPPORT_CATEGORIES = ['account', 'billing', 'technical', 'auto_apply', 'feedback', 'other'] as const
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number]

const SECRET_PATTERNS = [
  /(?:sk|pk)_[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi,
  /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*[^\s]{8,}/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /\b(?:\d[ -]*?){13,19}\b/g,
]

export function sanitizeSupportText(value: unknown) {
  if (typeof value !== 'string') return null
  const stripped = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!stripped || stripped.length > 5_000) return null
  let redacted = false
  const body = SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, () => {
    redacted = true
    return '[REDACTED]'
  }), stripped)
  return { body, redacted }
}

export function parseNewCase(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const subject = sanitizeSupportText(record.subject)
  const message = sanitizeSupportText(record.message)
  if (!subject || subject.body.length > 160 || !message || typeof record.category !== 'string' || !SUPPORT_CATEGORIES.includes(record.category as SupportCategory)) return null
  return { subject: subject.body, category: record.category as SupportCategory, message }
}

export function parseReply(value: unknown) {
  if (!value || typeof value !== 'object') return null
  return sanitizeSupportText((value as Record<string, unknown>).body)
}

export function getSlaDueAt(category: SupportCategory, priority: 'low' | 'normal' | 'high' | 'urgent', now = new Date()) {
  const baseHours = priority === 'urgent' ? 2 : priority === 'high' ? 8 : priority === 'low' ? 72 : 24
  const categoryHours = category === 'technical' || category === 'auto_apply' ? Math.min(baseHours, 12) : baseHours
  return new Date(now.getTime() + categoryHours * 60 * 60 * 1000)
}
