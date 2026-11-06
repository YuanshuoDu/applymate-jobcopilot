import { describe, expect, it } from 'vitest'
import { AUDIT_LIMIT_MESSAGES, auditCoverLetterFallbackName, checkAuditDocumentLimits, checkAuditEvidenceLimits } from './application-audit-limits'

describe('audit input limits', () => {
  // JSON.stringify(value, null, 2) adds two quote characters here.
  it('uses the exact serialized final resume boundary', () => {
    expect(checkAuditDocumentLimits('x'.repeat(11_998), null)).toEqual({ ok: true })
    expect(checkAuditDocumentLimits('x'.repeat(11_999), null)).toEqual({ ok: false, reason: 'final_resume_too_long' })
    // Escaping and indentation count toward the prompt limit.
    expect(checkAuditDocumentLimits({ value: '"'.repeat(6_000) }, null)).toEqual({ ok: false, reason: 'final_resume_too_long' })
  })

  it('uses exact optional letter and persona limits', () => {
    expect(checkAuditDocumentLimits({}, 'x'.repeat(8_000))).toEqual({ ok: true })
    expect(checkAuditDocumentLimits({}, 'x'.repeat(8_001))).toEqual({ ok: false, reason: 'cover_letter_too_long' })
    expect(checkAuditEvidenceLimits({}, 'x'.repeat(10_000))).toEqual({ ok: true })
    expect(checkAuditEvidenceLimits({}, 'x'.repeat(10_001))).toEqual({ ok: false, reason: 'persona_too_long' })
  })

  it('accounts for the actual cover-letter name fallback when there is no contact name', () => {
    expect(auditCoverLetterFallbackName({ contact: { name: 'Candidate' } }, 'Resume label')).toBeNull()
    expect(auditCoverLetterFallbackName({ contact: { name: '' } }, 'Fallback Candidate')).toBe('Fallback Candidate')
    expect(checkAuditDocumentLimits({}, 'Letter', 'x'.repeat(11_998))).toEqual({ ok: true })
    expect(checkAuditDocumentLimits({}, 'Letter', 'x'.repeat(11_999))).toEqual({ ok: false, reason: 'final_resume_too_long' })
    expect(checkAuditDocumentLimits({}, null, 'x'.repeat(12_001))).toEqual({ ok: true })
  })

  it('checks the independent source by the same JSON serialization', () => {
    expect(checkAuditEvidenceLimits('x'.repeat(11_998), '')).toEqual({ ok: true })
    expect(checkAuditEvidenceLimits('x'.repeat(11_999), '')).toEqual({ ok: false, reason: 'source_resume_too_long' })
    // String length matches slice, including UTF-16 surrogate pairs.
    expect(checkAuditDocumentLimits('😀'.repeat(5_999), null)).toEqual({ ok: true })
    expect(checkAuditDocumentLimits('😀'.repeat(6_000), null)).toEqual({ ok: false, reason: 'final_resume_too_long' })
  })

  it('fails closed on invalid or lossy JSON and invalid text', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    for (const content of [undefined, cyclic, { value: undefined }, { value: NaN }, { value: BigInt(1) }, [undefined], new Date()]) {
      expect(checkAuditDocumentLimits(content, null)).toEqual({ ok: false, reason: 'invalid_content' })
      expect(checkAuditEvidenceLimits(content, '')).toEqual({ ok: false, reason: 'invalid_content' })
    }
    expect(checkAuditDocumentLimits({}, undefined)).toEqual({ ok: false, reason: 'invalid_content' })
    expect(checkAuditEvidenceLimits({}, null)).toEqual({ ok: false, reason: 'invalid_content' })
    expect(AUDIT_LIMIT_MESSAGES.invalid_content).toContain('could not be read')
  })
})
