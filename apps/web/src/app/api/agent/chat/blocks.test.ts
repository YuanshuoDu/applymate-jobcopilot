import { describe, expect, it } from 'vitest'
import { approvalRequestFrom, automationDraftFrom } from './blocks'

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
})
