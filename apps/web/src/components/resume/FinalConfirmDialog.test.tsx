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

function renderDialog(initialAudit: ApplicationAudit | null, coverLetterContent: string | null = 'Dear Acme') {
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
      onDownload={vi.fn().mockResolvedValue(undefined)}
      exportedPackFolder={null}
    />,
  )
}

describe('FinalConfirmDialog audit state', () => {
  it('hydrates the independent audit detail from the current material audit', () => {
    const markup = renderDialog(audit)

    expect(markup).toContain('The audited package is supported.')
    expect(markup).not.toContain('Compares the final resume and cover letter')
  })

  it('routes unresolved audits back to Resume instead of running a second audit here', async () => {
    const source = await import('node:fs').then(fs => fs.readFileSync(new URL('./FinalConfirmDialog.tsx', import.meta.url), 'utf8'))

    expect(source).toContain('className="final-confirm-status-action"')
    expect(source).toContain('onClick={onReviewAudit}')
    expect(source).not.toContain('onAudit: () => Promise<ApplicationAudit | null>')
    expect(source).not.toContain('async function runAudit()')
  })

  it('treats a missing cover letter as optional in final confirmation', () => {
    const markup = renderDialog(null, null)

    expect(markup).toContain('Optional — no cover letter selected')
    expect(markup).toContain('Run the independent audit from Resume before final confirmation.')
    expect(markup).not.toContain('Select a final cover letter made for this resume version before confirming')
  })
})
