import { describe, expect, it, vi } from 'vitest'
import type { ApplicationPackage, PipelineCtx } from '../types'

vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('../application-control', () => ({
  holdForApplicationReview: vi.fn().mockResolvedValue({ id: 'application_task_1' }),
}))

import { runGate } from './gate'

function context(overrides: Partial<PipelineCtx['agentCfg']> = {}): PipelineCtx {
  return {
    userId: 'user_1',
    agentCfg: {
      id: 'config_1', userId: 'user_1', isRunning: true, dailyLimit: 3,
      minMatchScore: 50, autoApply: true, requireApproval: false,
      targetLocations: ['Dublin'], targetRoles: ['Cyber Security Analyst'],
      excludeCompanies: [], priorityCompanies: [], autoCoverLetter: true,
      coverTone: 'professional', useTailoredCV: true, model: 'MiniMax-M3',
      ...overrides,
    },
    roleConfigs: {} as PipelineCtx['roleConfigs'],
    resumeText: 'Security analyst', resumeContent: {} as PipelineCtx['resumeContent'],
    defaultResume: { id: 'resume_1', name: 'Base', templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
    aiConfig: { provider: 'minimax', model: 'MiniMax-M3' }, autonomous: true, emit: vi.fn(),
  }
}

function packageFor(score: number, tailoredResumeId?: string): ApplicationPackage {
  return {
    job: { id: 'job_1', company: 'Example', role: 'Cyber Security Analyst', description: null } as ApplicationPackage['job'],
    score, matchedKeywords: ['SOC'], missingKeywords: [], recommendation: '', tailoredResumeId,
  }
}

describe('runGate', () => {
  it('keeps a threshold-matching tailored resume in review even when autopilot is configured', async () => {
    const result = await runGate([packageFor(75, 'tailored_1')], context())
    expect(result.data?.approved).toHaveLength(0)
    expect(result.data?.pending).toHaveLength(1)
  })

  it('marks a below-threshold package as skipped by default', async () => {
    const result = await runGate([packageFor(49, 'tailored_1')], context())
    expect(result.data?.approved).toHaveLength(0)
    expect(result.data?.pending).toHaveLength(0)
    expect(result.data?.skipped).toHaveLength(1)
  })

  it('pauses for a candidate-approved borderline exception before holding it for review', async () => {
    const ctx = context({ autoApply: false, requireApproval: true })
    ctx.askUser = vi.fn().mockResolvedValue('add_to_pending')
    const result = await runGate([packageFor(49, 'tailored_1')], ctx)
    expect(result.data?.pending).toHaveLength(1)
    expect(result.data?.skipped).toHaveLength(0)
    expect(ctx.askUser).toHaveBeenCalledWith('reviewer', expect.any(String), expect.any(Array))
  })
})
