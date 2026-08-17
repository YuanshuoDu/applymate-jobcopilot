import { describe, expect, it } from 'vitest'
import { approvalRequestFrom, automationDraftFrom, resumeTailoringApprovalFrom } from './blocks'

describe('agent chat structured blocks', () => {
  it('extracts automation draft details from a natural-language request', () => {
    expect(automationDraftFrom('every day 9 Click to help me find it Berlin SWE，85 Create automation')).toMatchObject({
      name: 'Berlin SWE automation',
      triggerType: 'daily',
      cron: '0 9 * * *',
      targetRoles: ['SWE'],
      targetLocations: ['Berlin'],
      minScore: 85,
      requireApproval: true,
      autoApply: true,
    })
  })

  it('does not emit automation drafts for ordinary chat', () => {
    expect(automationDraftFrom('Explain the recent job rating')).toBeNull()
  })

  it('creates approval requests for sensitive apply actions', () => {
    expect(approvalRequestFrom('Approve delivery 4 positions', { pendingCount: 2, savedCount: 8 })).toMatchObject({
      type: 'apply_jobs',
      title: 'Approval required',
      impact: {
        applications: 4,
        coverLetters: 4,
        linkedinActions: false,
      },
      payload: {
        requestedCount: 4,
        requireApproval: true,
      },
    })
  })

  it('ignores non-sensitive chat prompts', () => {
    expect(approvalRequestFrom('Help me explain the rating', { pendingCount: 3, savedCount: 6 })).toBeNull()
  })

  it('asks for consent before the Writer changes a resume for a named job', () => {
    expect(resumeTailoringApprovalFrom('please for N26 of Backend Engineer Customize and optimize my resume', {
      resumeId: 'resume_1',
      jobs: [{ id: 'job_1', company: 'N26', role: 'Backend Engineer' }],
    })).toMatchObject({
      type: 'tailor_resume',
      payload: { resumeId: 'resume_1', jobId: 'job_1', requireApproval: true },
      impact: { externalSubmission: false },
    })
  })

  it('does not guess a job when multiple jobs exist and none is named', () => {
    expect(resumeTailoringApprovalFrom('Optimize my resume', {
      resumeId: 'resume_1',
      jobs: [{ id: 'job_1', company: 'N26', role: 'Backend Engineer' }, { id: 'job_2', company: 'Spotify', role: 'Data Engineer' }],
    })).toBeNull()
  })
})
