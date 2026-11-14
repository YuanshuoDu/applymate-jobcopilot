/** Limits match the exact UTF-16 character slices used in the audit prompt. */
export const AUDIT_RESUME_LIMIT = 12_000
export const AUDIT_COVER_LETTER_LIMIT = 8_000
export const AUDIT_PERSONA_LIMIT = 10_000

export type AuditLimitReason =
  | 'final_resume_too_long' | 'cover_letter_too_long'
  | 'source_resume_too_long' | 'persona_too_long' | 'invalid_content'

export const AUDIT_LIMIT_MESSAGES: Record<AuditLimitReason, string> = {
  final_resume_too_long: 'Shorten the final resume, then check the materials again.',
  cover_letter_too_long: 'Shorten the cover letter, then check the materials again.',
  source_resume_too_long: 'Shorten the source resume, then check the materials again.',
  persona_too_long: 'Shorten the confirmed profile information, then check the materials again.',
  invalid_content: 'The review content could not be read. Check the materials and try again.',
}

export type AuditLimitCheck = { ok: true } | { ok: false; reason: AuditLimitReason }

// JSON.stringify silently drops unsupported nested values. Reject them instead
// of certifying an audit of a different representation of the input.
function jsonText(value: unknown): string | null {
  const ancestors = new Set<object>()
  function valid(item: unknown): boolean {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (typeof item !== 'object' || ancestors.has(item)) return false
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false
    if (Object.getOwnPropertySymbols(item).length) return false
    ancestors.add(item)
    try {
      if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) if (!Object.prototype.hasOwnProperty.call(item, i) || !valid(item[i])) return false
        return true
      }
      return Object.entries(item).every(([, child]) => valid(child))
    } finally {
      ancestors.delete(item)
    }
  }
  try {
    if (!valid(value)) return null
    return JSON.stringify(value, null, 2) ?? null
  } catch {
    return null
  }
}

/** Match the name fallback used in the rendered cover-letter header. */
export function auditCoverLetterFallbackName(content: unknown, resumeName: string): string | null {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const contact = (content as Record<string, unknown>).contact
    if (contact && typeof contact === 'object' && !Array.isArray(contact) && (contact as Record<string, unknown>).name) return null
  }
  return resumeName
}

/** Check all document text sent to the auditor, before certifying a receipt. */
export function checkAuditDocumentLimits(resume: unknown, coverLetter: unknown, resumeName?: string): AuditLimitCheck {
  const text = jsonText(resume)
  if (text === null) return { ok: false, reason: 'invalid_content' }
  if (text.length > AUDIT_RESUME_LIMIT) return { ok: false, reason: 'final_resume_too_long' }
  if (coverLetter !== null && typeof coverLetter !== 'string') return { ok: false, reason: 'invalid_content' }
  if (typeof coverLetter === 'string' && coverLetter.length > AUDIT_COVER_LETTER_LIMIT) return { ok: false, reason: 'cover_letter_too_long' }
  if (coverLetter !== null && resumeName !== undefined) {
    if (typeof resumeName !== 'string') return { ok: false, reason: 'invalid_content' }
    const fallbackName = auditCoverLetterFallbackName(resume, resumeName)
    if (fallbackName !== null && text.length + fallbackName.length > AUDIT_RESUME_LIMIT) return { ok: false, reason: 'final_resume_too_long' }
  }
  return { ok: true }
}

/** The source and confirmed Persona must also fit the text supplied to the auditor. */
export function checkAuditEvidenceLimits(sourceResume: unknown, persona: unknown): AuditLimitCheck {
  const text = jsonText(sourceResume)
  if (text === null) return { ok: false, reason: 'invalid_content' }
  if (text.length > AUDIT_RESUME_LIMIT) return { ok: false, reason: 'source_resume_too_long' }
  if (typeof persona !== 'string') return { ok: false, reason: 'invalid_content' }
  if (persona.length > AUDIT_PERSONA_LIMIT) return { ok: false, reason: 'persona_too_long' }
  return { ok: true }
}
