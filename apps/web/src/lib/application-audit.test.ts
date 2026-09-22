import { describe, expect, it } from 'vitest'
import {
  auditActivityText, parseStoredApplicationAudit, sanitizeProposedValue, targetForAuditFinding,
} from './application-audit'
import type { ApplicationAudit, ApplicationAuditFinding } from './types'

function finding(overrides: Partial<ApplicationAuditFinding> = {}): ApplicationAuditFinding {
  return {
    area: 'resume', severity: 'warning', title: 'Review', evidence: 'Evidence', action: 'Fix it', ...overrides,
  }
}

describe('application audit helpers', () => {
  it('keeps legacy findings actionable with a conservative section target', () => {
    expect(targetForAuditFinding(finding({ title: 'Unsupported employer date', evidence: 'The role ended in 2022.' }))).toBe('experience')
    expect(targetForAuditFinding(finding({ area: 'cover_letter' }))).toBe('cover_letter')
    expect(targetForAuditFinding(finding({ area: 'job_match' }))).toBeUndefined()
  })

  it('only accepts replacement values that match the target shape', () => {
    expect(sanitizeProposedValue('summary', 'Supported wording')).toBe('Supported wording')
    expect(sanitizeProposedValue('skills', ['TypeScript', 'SQL'])).toEqual(['TypeScript', 'SQL'])
    expect(sanitizeProposedValue('skills', ['TypeScript', 4])).toBeNull()
    expect(sanitizeProposedValue('experience', [{ company: 'Acme', role: 'Engineer', period: '2021 – Present', bullets: ['Built systems.'] }])).toEqual([
      { company: 'Acme', role: 'Engineer', period: '2021 – Present', bullets: ['Built systems.'] },
    ])
    expect(sanitizeProposedValue('experience', [{ company: 'Acme', role: 'Engineer', bullets: ['Missing period.'] }])).toBeNull()
  })

  it('round-trips the canonical persisted audit activity format', () => {
    const audit: ApplicationAudit = {
      verdict: 'needs_review', summary: 'Review', matchScore: 70,
      findings: [finding({ target: 'summary', proposedValue: 'Supported wording' })], source: 'parent_resume', auditedAt: '2026-09-22T10:00:00.000Z',
    }
    const parsed = parseStoredApplicationAudit(auditActivityText('resume_1', null, audit, { resumeUpdatedAt: '2026-09-22T10:01:00.000Z' }))
    expect(parsed).toMatchObject({ resumeId: 'resume_1', coverLetterId: null, resumeUpdatedAt: '2026-09-22T10:01:00.000Z', audit })
  })
})
