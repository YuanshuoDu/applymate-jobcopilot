import { describe, expect, it } from 'vitest'
import { approvalRequestFrom, automationDraftFrom, resumeTailoringApprovalFrom } from './blocks'

describe('agent chat structured blocks', () => {
  it('extracts automation draft details from a natural-language request', () => {
    expect(automationDraftFrom('每天 9 点帮我找 Berlin SWE，85 分以上创建自动化')).toMatchObject({
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
    expect(automationDraftFrom('解释一下最近职位评分')).toBeNull()
  })

  it('creates approval requests for sensitive apply actions', () => {
    expect(approvalRequestFrom('批准投递 4 个职位', { pendingCount: 2, savedCount: 8 })).toMatchObject({
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
    expect(approvalRequestFrom('帮我解释评分', { pendingCount: 3, savedCount: 6 })).toBeNull()
  })

  it('asks for consent before the Writer changes a resume for a named job', () => {
    expect(resumeTailoringApprovalFrom('请为 N26 的 Backend Engineer 定制并优化我的简历', {
      resumeId: 'resume_1',
      jobs: [{ id: 'job_1', company: 'N26', role: 'Backend Engineer' }],
    })).toMatchObject({
      type: 'tailor_resume',
      payload: { resumeId: 'resume_1', jobId: 'job_1', requireApproval: true },
      impact: { externalSubmission: false },
    })
  })

  it('does not guess a job when multiple jobs exist and none is named', () => {
    expect(resumeTailoringApprovalFrom('优化我的简历', {
      resumeId: 'resume_1',
      jobs: [{ id: 'job_1', company: 'N26', role: 'Backend Engineer' }, { id: 'job_2', company: 'Spotify', role: 'Data Engineer' }],
    })).toBeNull()
  })
})
