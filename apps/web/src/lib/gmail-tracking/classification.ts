/**
 * Pure classification and subject inference for Gmail job-search messages.
 * These helpers intentionally describe evidence in an email; they do not
 * decide a My Jobs lifecycle transition.
 */

export const GMAIL_MESSAGE_KINDS = [
  'application_received',
  'interview_invitation',
  'offer',
  'rejection',
  'application_update',
  'recommendation_digest',
  'other',
] as const

export type GmailMessageKind = (typeof GMAIL_MESSAGE_KINDS)[number]

export interface GmailClassificationInput {
  subject: string
  excerpt?: string | null
  body?: string | null
}

export interface InferredApplicationMetadata {
  company: string | null
  role: string | null
}

const RECOMMENDATION_PATTERN = /\b(job\s*(?:alert|recommendations?|matches|digest)|jobs?\s+(?:for you|you may like|recommended)|recommended\s+(?:jobs?|roles?|positions?)|new\s+(?:jobs?|roles?|positions?)\s+(?:for you|matching)|weekly\s+(?:jobs?|career)\s+(?:digest|update))\b/i
const OFFER_PATTERN = /\b(job\s+offer|your\s+(?:job\s+)?offer|offer\s+letter|pleased\s+to\s+(?:offer|extend)|(?:received|accept)\s+(?:an\s+)?offer|offer\s+for\s+(?:the\s+)?(?:role|position))\b/i
const REJECTION_PATTERN = /\b(unfortunately|regret(?:\s+to\s+inform)?|not\s+(?:moving\s+forward|selected|proceeding)|(?:application|candidacy)\s+(?:was\s+)?unsuccessful|decided\s+not\s+to|other\s+candidates|rejection)\b/i
const INTERVIEW_PATTERN = /\b(interview\s+(?:invitation|invite|request|scheduled)|invite\s+you\s+(?:to|for)\s+(?:an?\s+)?(?:interview|(?:video|phone|introductory)\s+(?:call|screen))|schedule\s+(?:an?\s+)?(?:interview|call)|phone\s+screen|video\s+interview|technical\s+(?:interview|assessment)|coding\s+challenge|take[- ]home\s+(?:assignment|exercise)|next\s+step(?:s)?\s*[:\-]?\s*(?:interview|schedule))\b/i
const RECEIPT_PATTERN = /\b(application\s+(?:has\s+been\s+)?received|(?:thank\s+you|thanks)\s+for\s+applying|we(?:'|\s+have)?\s+received\s+(?:your\s+)?application|application\s+confirmation|confirm(?:ing)?\s+(?:your\s+)?application|application\s+submitted)\b/i
const UPDATE_PATTERN = /\b(application\s+(?:status\s+)?update|(?:still|currently|now)\s+(?:under\s+)?review|(?:your\s+)?application\s+(?:is\s+)?(?:under\s+)?(?:review|being\s+reviewed|under\s+consideration)|we(?:'re|\s+are)\s+reviewing|assessment\s+in\s+progress|application\s+is\s+being\s+considered)\b/i
const VIEW_ONLY_PATTERN = /\b(?:viewed|looked\s+at)\s+(?:your\s+)?(?:profile|application)\b/i

/**
 * Classify a message into durable Gmail evidence categories. A profile-view
 * notification is deliberately `other`: it is not proof of an application
 * lifecycle event.
 */
export function classifyGmailMessage(input: GmailClassificationInput): GmailMessageKind
export function classifyGmailMessage(subject: string, content?: string | null): GmailMessageKind
export function classifyGmailMessage(
  inputOrSubject: GmailClassificationInput | string,
  content: string | null = null,
): GmailMessageKind {
  const input = typeof inputOrSubject === 'string'
    ? { subject: inputOrSubject, excerpt: content }
    : inputOrSubject
  const subject = normaliseText(input.subject)
  const message = normaliseText([input.subject, input.excerpt, input.body].filter(isString).join(' '))

  // Recommendation subjects are intentionally checked before job-specific
  // vocabulary: a role title in a daily alert may itself contain "interview".
  if (RECOMMENDATION_PATTERN.test(subject)) return 'recommendation_digest'
  if (VIEW_ONLY_PATTERN.test(message)) return 'other'
  if (OFFER_PATTERN.test(message)) return 'offer'
  if (REJECTION_PATTERN.test(message)) return 'rejection'
  if (INTERVIEW_PATTERN.test(message)) return 'interview_invitation'
  if (RECEIPT_PATTERN.test(message)) return 'application_received'
  if (UPDATE_PATTERN.test(message)) return 'application_update'
  if (RECOMMENDATION_PATTERN.test(message)) return 'recommendation_digest'
  return 'other'
}

/**
 * Best-effort role and company inference from an application-email subject.
 * It intentionally returns null for uncertain fields instead of guessing from
 * a sender address or creating a loose job match.
 */
export function inferApplicationMetadata(subject: string): InferredApplicationMetadata {
  const cleaned = cleanSubject(subject)
  if (!cleaned) return { company: null, role: null }

  const companyFirst = cleaned.match(/^(.+?)\s*(?:[-–—|:]\s*)?(?:application(?:\s+(?:update|received|confirmation))?|interview(?:\s+invitation)?|offer)\s+(?:for|with|:)?\s*(.+)$/i)
  if (companyFirst) {
    const company = cleanCompany(companyFirst[1])
    const role = cleanRole(companyFirst[2])
    if (company || role) return { company, role }
  }

  const companyThenRole = cleaned.match(/\b(?:interview|offer|application)\s+(?:at|with)\s+(.+?)\s+for\s+(.+)$/i)
  if (companyThenRole) {
    return { company: cleanCompany(companyThenRole[1]), role: cleanRole(companyThenRole[2]) }
  }

  const roleAtCompany = cleaned.match(/(?:\b(?:application|interview|offer|role|position)\b[^:–—|]*[:–—|]\s*)?(.+?)\s+\b(?:at|with|@)\s+(.+?)(?:\s*[|–—:]\s*.*)?$/i)
  if (roleAtCompany) {
    return { role: cleanRole(roleAtCompany[1]), company: cleanCompany(roleAtCompany[2]) }
  }

  const roleFirst = cleaned.match(/\b(?:application|interview|offer)\s+(?:for|to)\s+(.+)$/i)
  if (roleFirst) return { company: null, role: cleanRole(roleFirst[1]) }

  return { company: null, role: null }
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normaliseText(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanSubject(subject: string): string {
  return normaliseText(subject)
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '')
    .replace(/^\[?(?:external|candidate update)\]?\s*/i, '')
    .trim()
}

function cleanRole(value: string): string | null {
  const cleaned = cleanSegment(value)
    .replace(/^(?:your\s+)?(?:application(?:\s+(?:update|received|confirmation))?|interview(?:\s+invitation)?|offer)\s*(?:for|to|:|-)?\s*/i, '')
  return isUsefulMetadata(cleaned) ? cleaned : null
}

function cleanCompany(value: string): string | null {
  const cleaned = cleanSegment(value)
  return isUsefulMetadata(cleaned) ? cleaned : null
}

function cleanSegment(value: string): string {
  return normaliseText(value)
    .replace(/^[\s:|–—-]+|[\s:|–—-]+$/g, '')
    .replace(/[.!?]+$/g, '')
    .trim()
}

function isUsefulMetadata(value: string): boolean {
  return value.length >= 2 && value.length <= 100 && !/^(?:your|the|a|an|application|interview|offer|update)$/i.test(value)
}
