import { beforeEach, describe, expect, it, vi } from 'vitest'
import { auditActivityText, parseStoredApplicationAudit, type StoredApplicationAudit } from './application-audit'
import { signedAuditActivityText, verifyApplicationAuditReceipt } from './application-audit-receipt'
import type { ApplicationAudit } from './types'

const secret = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth-secret', () => ({ getAuthJwtSecret: secret }))
const scope = { userId: 'user_1', jobId: 'job_1' }
const revision = '2026-11-02T09:00:00.000Z'
const audit: ApplicationAudit = {
  verdict: 'pass', matchScore: 90, summary: 'Supported.', source: 'parent_resume', auditedAt: revision,
  findings: [{ area: 'resume', severity: 'pass', title: 'Supported', evidence: 'Original resume.', action: 'None.' }],
}
function signed(): StoredApplicationAudit {
  return parseStoredApplicationAudit(signedAuditActivityText(scope, 'resume_1', 'letter_1', audit, {
    resumeUpdatedAt: revision, coverLetterUpdatedAt: revision,
  }))!
}

describe('server application-audit receipts', () => {
  beforeEach(() => { secret.mockReturnValue(new TextEncoder().encode('unit-test-audit-signing-key')) })

  it('verifies a signed result after its activity JSON round trip', () => {
    const stored = signed()
    expect(stored.receipt).toMatchObject({ version: 1, signature: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(verifyApplicationAuditReceipt(scope, stored)).toBe(true)
    const reordered = { ...stored, audit: Object.fromEntries(Object.entries(stored.audit).reverse()) } as StoredApplicationAudit
    expect(verifyApplicationAuditReceipt(scope, reordered)).toBe(true)
  })

  it.each(['userId', 'jobId'] as const)('rejects replay under a different %s', field => {
    expect(verifyApplicationAuditReceipt({ ...scope, [field]: 'different' }, signed())).toBe(false)
  })

  it.each(['resumeId', 'coverLetterId', 'resumeUpdatedAt', 'coverLetterUpdatedAt'] as const)('rejects changed %s', field => {
    expect(verifyApplicationAuditReceipt(scope, { ...signed(), [field]: 'altered' })).toBe(false)
  })

  it('binds the complete verdict, findings, and audit time', () => {
    const stored = signed()
    for (const changed of [
      { ...stored.audit, verdict: 'blocked' as const },
      { ...stored.audit, auditedAt: '2026-11-03T09:00:00.000Z' },
      { ...stored.audit, findings: [{ ...stored.audit.findings[0], evidence: 'Forged source.' }] },
    ]) expect(verifyApplicationAuditReceipt(scope, { ...stored, audit: changed })).toBe(false)
  })

  it('rejects unsigned historical activity even when it asserts a complete pass', () => {
    const historical = parseStoredApplicationAudit(auditActivityText('resume_1', null, audit, { resumeUpdatedAt: revision }))
    expect(verifyApplicationAuditReceipt(scope, historical)).toBe(false)
    expect(verifyApplicationAuditReceipt(scope, null)).toBe(false)
  })

  it.each(['', '00', 'z'.repeat(64), '0'.repeat(64)])('fails closed for malformed or wrong signature %s', signature => {
    expect(verifyApplicationAuditReceipt(scope, { ...signed(), receipt: { version: 1, signature } })).toBe(false)
  })

  it('requires a new audit after the server signing secret rotates', () => {
    const stored = signed()
    secret.mockReturnValue(new TextEncoder().encode('rotated-unit-test-key'))
    expect(verifyApplicationAuditReceipt(scope, stored)).toBe(false)
  })

  it('does not mint or verify receipts when server configuration is unavailable', () => {
    const stored = signed()
    secret.mockImplementation(() => { throw new Error('Signing configuration unavailable') })
    expect(verifyApplicationAuditReceipt(scope, stored)).toBe(false)
    expect(() => signed()).toThrow('Signing configuration unavailable')
  })
})
