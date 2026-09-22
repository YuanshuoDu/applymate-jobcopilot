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
      'resume.auditNeedsRerunShort': 'Needs re-run',
      'resume.auditBlockedShort': 'Blocked',
      'resume.auditNoIssues': 'No unresolved factual issues found.',
      'resume.auditChangedSinceRun': 'The material changed after this audit. Run it again before confirming.',
      'resume.auditRun': 'Run independent audit',
      'resume.auditRunAgain': 'Run audit again',
      'resume.auditFindingsTitle': 'Findings to fix',
      'resume.auditFindingsCount': 'items',
      'resume.auditAppliedCount': 'applied',
      'resume.auditAreaResume': 'Resume',
      'resume.auditAreaCoverLetter': 'Cover letter',
      'resume.auditAreaJobMatch': 'Job match',
      'resume.auditCritical': 'Critical',
      'resume.auditWarning': 'Warning',
      'resume.auditEvidenceLabel': 'Evidence',
      'resume.auditActionLabel': 'Recommended fix',
      'resume.auditGeneratedLabel': 'Generated correction',
      'resume.auditEditResume': 'Edit resume',
      'resume.auditEditCoverLetter': 'Edit cover letter',
      'resume.auditReviewJob': 'Review job',
      'resume.auditApplyGenerated': 'Apply generated fix',
      'resume.auditGenerateAndApply': 'Generate & apply',
      'resume.auditAppliedAction': 'Applied',
      'resume.auditCopyGenerated': 'Copy generated content',
      'resume.auditCopyAction': 'Copy fix',
      'resume.auditCopiedAction': 'Copied',
      'resume.auditFixThenRerun': 'Make the change, then run the audit again.',
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

const needsReviewAudit: ApplicationAudit = {
  verdict: 'needs_review',
  summary: 'One factual claim needs attention.',
  matchScore: 76,
  findings: [{ area: 'resume', severity: 'warning', title: 'Unsupported claim', evidence: 'The source does not contain this metric.', action: 'Remove or soften the metric.' }],
  source: 'parent_resume',
  auditedAt: '2026-09-21T12:01:00.000Z',
}

const generatedAudit: ApplicationAudit = {
  ...needsReviewAudit,
  findings: [{
    ...needsReviewAudit.findings[0],
    target: 'summary',
    proposedValue: 'A supported summary without the unsupported metric.',
  }],
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

  it('keeps findings and their editing actions in the same audit surface', () => {
    const markup = renderToStaticMarkup(
      <ResumeAuditCard audit={needsReviewAudit} auditing={false} hasLinkedJob hasCoverLetter={false} onReviewFinding={vi.fn()} onAudit={vi.fn()} />,
    )

    expect(markup).toContain('Findings to fix')
    expect(markup).toContain('Unsupported claim')
    expect(markup).toContain('Edit resume')
    expect(markup).toContain('Copy fix')
    expect(markup).toContain('Make the change, then run the audit again.')
  })

  it('shows generated correction content and keeps the apply action visible', () => {
    const onApply = vi.fn()
    const markup = renderToStaticMarkup(
      <ResumeAuditCard audit={generatedAudit} auditing={false} hasLinkedJob hasCoverLetter={false} onApplyFinding={onApply} onAudit={vi.fn()} />,
    )

    expect(markup).toContain('Generated correction')
    expect(markup).toContain('A supported summary without the unsupported metric.')
    expect(markup).toContain('Apply generated fix')
  })

  it('shows an applied finding instead of removing it from the audit card', () => {
    const markup = renderToStaticMarkup(
      <ResumeAuditCard audit={{ ...generatedAudit, findings: [{ ...generatedAudit.findings[0], applied: true }] }} auditing={false} hasLinkedJob hasCoverLetter={false} onApplyFinding={vi.fn()} onAudit={vi.fn()} />,
    )

    expect(markup).toContain('Applied')
    expect(markup).not.toContain('Apply generated fix')
  })
})
