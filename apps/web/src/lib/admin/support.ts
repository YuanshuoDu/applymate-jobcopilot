import type { SupportCasePriority, SupportCaseStatus } from '@prisma/client'

export const SUPPORT_CATEGORIES = ['account', 'billing', 'technical', 'auto_apply', 'feedback', 'other'] as const
export const SUPPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

export interface SupportCaseCreateInput {
  subject: string
  category: string
  priority: SupportCasePriority
}

export function parseSupportCaseCreateInput(value: unknown): SupportCaseCreateInput {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const subject = typeof row.subject === 'string' ? row.subject.trim() : ''
  if (!subject || subject.length > 120) throw new Error('Subject is required')
  const category = typeof row.category === 'string' ? row.category : ''
  if (!(SUPPORT_CATEGORIES as readonly string[]).includes(category)) throw new Error('Category is invalid')
  const priority = typeof row.priority === 'string' && (SUPPORT_PRIORITIES as readonly string[]).includes(row.priority)
    ? row.priority as SupportCasePriority
    : 'normal'
  return { subject, category, priority }
}

export function parseSupportCaseStatus(value: unknown): SupportCaseStatus | undefined {
  return value === 'open' || value === 'in_progress' || value === 'waiting_on_customer' || value === 'resolved' || value === 'closed' ? value : undefined
}

export function parseSupportCasePriority(value: unknown): SupportCasePriority | undefined {
  return value === 'low' || value === 'normal' || value === 'high' || value === 'urgent' ? value : undefined
}

export function sanitizeSupportMessage(value: unknown, maxLength = 5000): { text: string; redacted: boolean } {
  if (typeof value !== 'string') throw new Error('Message is required')
  const stripped = value.replace(/<[^>]*>/g, '').trim()
  if (!stripped || stripped.length > maxLength) throw new Error('Message is invalid')
  const secretPattern = /(sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN[\s\S]+?-----|\b\d{13,19}\b)/gi
  const text = stripped.replace(secretPattern, '[REDACTED]')
  return { text, redacted: text !== stripped }
}

export function supportStatusTransition(current: SupportCaseStatus | string, next: SupportCaseStatus | string): boolean {
  return current === 'open' && next === 'in_progress' || current === 'open' && next === 'resolved' || current === 'in_progress' && ['waiting_on_customer', 'resolved', 'closed'].includes(next) || current === 'waiting_on_customer' && next === 'in_progress' || current === 'resolved' && ['closed', 'in_progress'].includes(next)
}

export function supportSlaDueAt(priority: string, now = new Date()): Date {
  const hours = priority === 'urgent' ? 4 : priority === 'high' ? 12 : priority === 'low' ? 72 : 24
  return new Date(now.getTime() + hours * 60 * 60 * 1000)
}
