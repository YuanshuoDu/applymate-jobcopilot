import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ApplicationAudit } from '@/lib/types'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'resume.independentAudit': 'Independent Auditor review',
      'resume.auditScopeResumeAndCoverLetter': 'Resume + cover letter',
      'resume.auditScopeResumeOnly': 'Resume only · cover letter optional',
      'resume.auditLinkJobHint': 'Link this resume to a saved job to compare it with the job description.',
      'resume.auditReadyDetail': 'Run the independent audit to check factual consistency before final confirmation.',
      'resume.auditRunning': 'Auditing your materials…',
      'resume.auditRunningDetail': 'Saving the latest resume edits, then comparing the final materials with the source resume and job.',
      'resume.auditNotRun': 'Not run yet',
      'resume.auditPassed': 'Audit passed',
      'resume.auditNeedsReviewShort': 'Needs review',
      'resume.auditBlockedShort': 'Blocked',
      'resume.auditNoIssues': 'No unresolved factual issues found.',
      'resume.auditRun': 'Run independent audit',
      'resume.auditRunAgain': 'Run audit again',
    }[key] ?? key),
  }),
}))

import { ResumeAuditCard } from './ResumeAuditCard'

const passedAudit: ApplicationAudit = {
  verdict: 'pass',
  summary: 'The final materials are supported by the source resume.',
  matchScore: 94,
  findings: [{ area: 'resume', severity: 'pass', title: 'Resume supported', evidence: 'Supported', action: 'No action' }],
  source: 'parent_resume',
  auditedAt: '2026-09-21T12:00:00.000Z',
}

describe('ResumeAuditCard', () => {
  it('runs directly from Resume without a truthfulness confirmation', () => {
    const markup = renderToStaticMarkup(
      <ResumeAuditCard audit={null} auditing={false} hasLinkedJob hasCoverLetter={false} onAudit={vi.fn()} />,
    )

    expect(markup).toContain('Run independent audit')
    expect(markup).toContain('Resume only · cover letter optional')
    expect(markup).not.toContain('I confirm')
  })

  it('keeps a passed result visible in the Resume audit card', () => {
    const markup = renderToStaticMarkup(
      <ResumeAuditCard audit={passedAudit} auditing={false} hasLinkedJob hasCoverLetter onAudit={vi.fn()} />,
    )

    expect(markup).toContain('Audit passed')
    expect(markup).toContain('The final materials are supported by the source resume.')
    expect(markup).toContain('No unresolved factual issues found.')
  })
})
