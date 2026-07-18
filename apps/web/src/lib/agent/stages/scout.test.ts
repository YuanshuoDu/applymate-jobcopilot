import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineCtx } from '../types'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
  activityCreate: vi.fn(),
  discoverJobs: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    job: { findMany: mocks.findMany, create: mocks.create },
    activity: { create: mocks.activityCreate },
  },
}))

vi.mock('@/lib/agent/discover', () => ({ discoverJobs: mocks.discoverJobs }))

import { runScout } from './scout'

const savedJob = {
  id: 'job_1', userId: 'user_1', company: 'Valid Co', logo: null,
  role: 'Software Engineer', location: 'Dublin', status: 'saved', score: null,
  url: 'https://example.com/valid', description: null, salary: null, source: 'agent',
  notes: null, coverLetter: null, analysisNote: null, keywords: null,
  appliedAt: null, followUpAt: null, createdAt: new Date(), updatedAt: new Date(),
  finalResumeId: null, finalCoverLetterId: null,
}

function context(): PipelineCtx {
  return {
    userId: 'user_1',
    agentCfg: {
      id: 'config_1', userId: 'user_1', isRunning: true, dailyLimit: 10,
      minMatchScore: 70, autoApply: false, requireApproval: true,
      targetLocations: ['Dublin'], targetRoles: ['Software Engineer'],
      excludeCompanies: [], priorityCompanies: [], autoCoverLetter: false,
      coverTone: 'professional', useTailoredCV: true, model: 'minimax',
    },
    roleConfigs: {} as PipelineCtx['roleConfigs'], resumeText: '',
    resumeContent: {} as PipelineCtx['resumeContent'],
    defaultResume: { id: 'resume_1', name: 'Base resume', templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
    aiConfig: {} as PipelineCtx['aiConfig'], autonomous: false, emit: vi.fn(),
  }
}

describe('runScout', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([savedJob])
    mocks.activityCreate.mockResolvedValue({})
    mocks.discoverJobs.mockResolvedValue([
      { title: 'Invalid record', company: 'Broken Co', location: 'Dublin', url: 'https://example.com/broken', description: '', salary: null, logo: null, source: 'test' },
      { title: 'Software Engineer', company: 'Valid Co', location: 'Dublin', url: 'https://example.com/valid', description: '', salary: null, logo: null, source: 'test' },
    ])
  })

  it('continues when one discovered job fails to persist', async () => {
    mocks.create
      .mockRejectedValueOnce(new Error('Invalid job payload'))
      .mockResolvedValueOnce({ id: 'job_1' })

    const result = await runScout(context())

    expect(result).toMatchObject({ ok: true, data: { discovered: 1, jobs: [savedJob] } })
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
  })
})
