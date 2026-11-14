import { AUDIT_LIMIT_MESSAGES, type AuditLimitReason } from './application-audit-limits'

const keys: Record<AuditLimitReason, string> = {
  final_resume_too_long: 'application.auditLimit.finalResume',
  cover_letter_too_long: 'application.auditLimit.coverLetter',
  source_resume_too_long: 'application.auditLimit.sourceResume',
  persona_too_long: 'application.auditLimit.persona',
  invalid_content: 'application.auditLimit.invalidContent',
}

/** Only fixed server-owned errors receive audit-limit guidance. */
export function auditLimitMessageKey(error: unknown): string | null {
  if (typeof error !== 'string') return null
  for (const reason of Object.keys(keys) as AuditLimitReason[]) {
    if (error === AUDIT_LIMIT_MESSAGES[reason]) return keys[reason]
  }
  return null
}
