import { describe, expect, it } from 'vitest'
import { sameApplicationAudit } from './application-audit-identity'

describe('audit identity', () => {
  it('invalidates only the same job, resume and audit timestamp', () => {
    const original = { jobId: 'job-1', resumeId: 'resume-1', auditedAt: '2026-01-01T00:00:00Z' }
    expect(sameApplicationAudit(original, { ...original })).toBe(true)
    expect(sameApplicationAudit(original, { ...original, jobId: 'job-2' })).toBe(false)
    expect(sameApplicationAudit(original, { ...original, resumeId: 'resume-2' })).toBe(false)
    expect(sameApplicationAudit(original, { ...original, auditedAt: '2026-01-02T00:00:00Z' })).toBe(false)
    expect(sameApplicationAudit(original, null)).toBe(false)
  })
})
