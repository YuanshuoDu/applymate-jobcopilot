import { describe, expect, it } from 'vitest'
import { AUDIT_LIMIT_MESSAGES } from './application-audit-limits'
import { auditLimitMessageKey } from './application-audit-limit-message'
import { hasTranslation, translate } from './i18n'
import { localizeToastText } from '@/components/ui'

describe('application audit limit guidance', () => {
  it.each([
    ['final_resume_too_long', 'application.auditLimit.finalResume'],
    ['cover_letter_too_long', 'application.auditLimit.coverLetter'],
    ['source_resume_too_long', 'application.auditLimit.sourceResume'],
    ['persona_too_long', 'application.auditLimit.persona'],
    ['invalid_content', 'application.auditLimit.invalidContent'],
  ] as const)('maps the exact %s response to trusted English and Chinese text', (reason, key) => {
    expect(auditLimitMessageKey(AUDIT_LIMIT_MESSAGES[reason])).toBe(key)
    expect(hasTranslation('en', key)).toBe(true)
    expect(hasTranslation('zh', key)).toBe(true)
    expect(translate('en', key)).not.toBe(key)
    expect(translate('zh', key)).toMatch(/[\u3400-\u9fff]/)
    expect(localizeToastText('zh', translate('zh', key))).toBe(translate('zh', key))
  })

  it('does not misclassify modified or unknown server errors', () => {
    for (const message of [
      `${AUDIT_LIMIT_MESSAGES.final_resume_too_long} extra`,
      `prefix ${AUDIT_LIMIT_MESSAGES.cover_letter_too_long}`,
      'Network error', '', null, undefined, { error: AUDIT_LIMIT_MESSAGES.persona_too_long },
    ]) expect(auditLimitMessageKey(message)).toBeNull()
  })
})
