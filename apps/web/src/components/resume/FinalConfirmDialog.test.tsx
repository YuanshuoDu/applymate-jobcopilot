import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ApplicationAudit, Job, ResumeContent } from '@/lib/types'
import { FinalConfirmDialog } from './FinalConfirmDialog'

const job = {
  id: 'job-1', company: 'Acme', role: 'Engineer', finalResumeId: 'resume-1', finalCoverLetterId: 'letter-1',
} as Job

const resumeContent: ResumeContent = {
  contact: { name: 'Ada', email: 'ada@example.com', location: 'Dublin' },
  summary: 'Engineer', experience: [], education: [], skills: [],
}

const audit: ApplicationAudit = {
  verdict: 'pass', summary: 'The audited package is supported.', matchScore: 92,
  findings: [], source: 'parent_resume', auditedAt: '2026-09-17T10:00:00.000Z',
}

function renderDialog(initialAudit: ApplicationAudit | null, coverLetterContent: string | null = 'Dear Acme', overrides: Partial<React.ComponentProps<typeof FinalConfirmDialog>> = {}) {
  return renderToStaticMarkup(
    <FinalConfirmDialog
      job={job}
      resumeName="Ada's Resume"
      templateName="Clean"
      pendingSuggestions={0}
      isDirty={false}
      packReady={true}
      resumeContent={resumeContent}
      templateId="clean"
      templateOptions={{}}
      coverLetterContent={coverLetterContent}
      initialAudit={initialAudit}
      onClose={vi.fn()}
      onReviewSuggestions={vi.fn()}
      onCreateCoverLetter={vi.fn()}
      onLinkJob={vi.fn()}
      onReviewAudit={vi.fn()}
      onConfirm={vi.fn().mockResolvedValue(true)}
      onOpenApplication={vi.fn()}
      {...overrides}
    />,
  )
}

describe('FinalConfirmDialog audit state', () => {
  it('hydrates the independent audit detail from the current material audit', () => {
    const markup = renderDialog(audit)

    expect(markup).toContain('The audited package is supported.')
    expect(markup).not.toContain('Compares the final resume and cover letter')
  })

  it('shows one actionable audit entry when a finding needs review', () => {
    const markup = renderDialog({ ...audit, verdict: 'needs_review' }, null, { packReady: false })

    expect(markup.match(/class="final-confirm-status-action"/g)).toHaveLength(1)
    expect(markup).toMatch(/class="final-confirm-primary" disabled=""/)
    expect(markup).not.toContain('final-material-preview')
  })

  it('treats a missing cover letter as optional in final confirmation', () => {
    const markup = renderDialog(null, null)

    expect(markup).toContain('Optional — no cover letter selected')
    expect(markup).toContain('Run the independent audit from Resume before final confirmation.')
    expect(markup).not.toContain('Select a final cover letter made for this resume version before confirming')
  })

  it('enables material confirmation immediately for a current passing resume-only audit', () => {
    const markup = renderDialog(audit, null, { packReady: false })

    expect(markup).toContain('Optional — no cover letter selected')
    expect(markup).not.toMatch(/class="final-confirm-primary" disabled=""/)
    expect(markup).not.toContain('is-checking')
  })

  it.each([
    ['missing audit', { initialAudit: null }],
    ['unsaved material changes', { isDirty: true }],
    ['missing job', { job: null }],
    ['unreviewed suggestions', { pendingSuggestions: 1 }],
  ] as const)('keeps confirmation blocked for %s', (_reason, overrides) => {
    const markup = renderDialog(audit, null, { packReady: false, ...overrides })
    expect(markup).toMatch(/class="final-confirm-primary" disabled=""/)
  })

  it('does not display a previously confirmed package as ready after an edit', () => {
    const markup = renderDialog(audit, null, { packReady: true, isDirty: true })

    expect(markup).not.toContain('class="final-confirm-ready"')
    expect(markup).not.toContain('final-material-preview')
    expect(markup).toMatch(/class="final-confirm-primary" disabled=""/)
  })
})
