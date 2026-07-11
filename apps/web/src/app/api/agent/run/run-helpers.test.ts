import type { AgentConfig } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { pipelineAgentConfigFrom } from './run-helpers'

describe('agent run helpers', () => {
  it('maps Prisma AgentConfig into the pipeline config contract', () => {
    const config: AgentConfig = {
      id: 'cfg_1',
      userId: 'user_1',
      isRunning: true,
      dailyLimit: 12,
      minMatchScore: 82,
      autoApply: false,
      requireApproval: true,
      targetLocations: ['Berlin'],
      targetRoles: ['SWE'],
      excludeCompanies: ['BadCo'],
      priorityCompanies: ['N26'],
      autoCoverLetter: true,
      coverTone: 'direct',
      useTailoredCV: true,
      salaryMin: 70000,
      salaryMax: 90000,
      notifyApply: true,
      notifyReject: false,
      weeklySummary: true,
      followUpReminder: true,
      followUpDays: 5,
      model: 'claude-test',
      createdAt: new Date('2026-06-18T08:00:00Z'),
      updatedAt: new Date('2026-06-18T08:00:00Z'),
    }

    expect(pipelineAgentConfigFrom(config)).toEqual({
      id: 'cfg_1',
      userId: 'user_1',
      isRunning: true,
      dailyLimit: 12,
      minMatchScore: 82,
      autoApply: false,
      requireApproval: true,
      targetLocations: ['Berlin'],
      targetRoles: ['SWE'],
      excludeCompanies: ['BadCo'],
      priorityCompanies: ['N26'],
      autoCoverLetter: true,
      coverTone: 'direct',
      useTailoredCV: true,
      model: 'claude-test',
      throttleMs: 300,
    })
  })
})
