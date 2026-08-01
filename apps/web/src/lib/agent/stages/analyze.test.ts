import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@prisma/client'
import type { PipelineCtx } from '../types'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  activityCreate: vi.fn(),
  applicationTaskUpdateMany: vi.fn(),
  modelChat: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    job: { update: mocks.update },
    activity: { create: mocks.activityCreate },
    applicationTask: { upsert: vi.fn(), updateMany: mocks.applicationTaskUpdateMany },
  },
}))

vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  stripFences: (text: string) => text.replace(/```json|```/g, '').trim(),
}))

import { runAnalyze } from './analyze'

const job = {
  id: 'job_1', userId: 'user_1', company: 'Example Co', logo: null,
  role: 'Software Engineer', location: 'Dublin', status: 'saved', score: null,
  url: 'https://jobs.lever.co/example/123', description: 'TypeScript and Node.js role.', salary: null,
  source: 'agent', notes: null, coverLetter: null, analysisNote: null, keywords: null,
  appliedAt: null, followUpAt: null, createdAt: new Date(), updatedAt: new Date(),
  finalResumeId: null, finalCoverLetterId: null,
} as Job

function context(emit = vi.fn()): PipelineCtx {
  return {
    userId: 'user_1',
    agentCfg: {
      id: 'config_1', userId: 'user_1', isRunning: true, dailyLimit: 10,
      minMatchScore: 70, autoApply: false, requireApproval: true,
      targetLocations: ['Dublin'], targetRoles: ['Software Engineer'],
      excludeCompanies: [], priorityCompanies: [], autoCoverLetter: false,
      coverTone: 'professional', useTailoredCV: true, model: 'MiniMax-M3', throttleMs: 0,
    },
    roleConfigs: {
      analyst: { provider: 'minimax', model: 'MiniMax-M3', enabled: true },
    } as PipelineCtx['roleConfigs'],
    resumeText: 'TypeScript developer with Node.js experience.',
    resumeContent: {} as PipelineCtx['resumeContent'],
    defaultResume: { id: 'resume_1', name: 'Base resume', templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
    aiConfig: { provider: 'minimax', model: 'MiniMax-M3' }, autonomous: false, emit,
  }
}

describe('runAnalyze', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.update.mockResolvedValue({})
    mocks.activityCreate.mockResolvedValue({})
    mocks.applicationTaskUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('persists a structured AI score using a completion budget that supports reasoning models', async () => {
    mocks.modelChat.mockResolvedValue({
      text: '{"score":73,"matchedKeywords":["TypeScript"],"missingKeywords":["AWS"],"recommendation":"Add cloud experience."}',
    })

    const result = await runAnalyze([job], context())

    expect(result).toMatchObject({ ok: true, data: { failed: 0, scoredJobs: [{ score: 73 }] } })
    expect(mocks.modelChat).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), 1600)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { score: 73, analysisNote: 'Add cloud experience.' } }))
  })

  it('treats a non-JSON AI response as a failed score instead of persisting 0%', async () => {
    const emit = vi.fn()
    mocks.modelChat.mockResolvedValue({ text: 'I cannot score this job.' })

    const result = await runAnalyze([job], context(emit))

    expect(result).toMatchObject({ ok: false, error: 'All jobs failed to score' })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', checkpoint: 'match_analysis_failed' }),
    }))
    expect(emit).toHaveBeenCalledWith('job_error', expect.objectContaining({ error: 'AI returned no JSON score' }))
  })

  it('pauses for the candidate decision and records skipped jobs with no description', async () => {
    const noDescriptionJob = { ...job, description: null }
    const ctx = context()
    ctx.askUser = vi.fn().mockResolvedValue('skip_no_desc')

    const result = await runAnalyze([noDescriptionJob], ctx)

    expect(result).toMatchObject({ ok: false, error: 'All jobs failed to score' })
    expect(ctx.askUser).toHaveBeenCalledWith('analyst', expect.any(String), expect.any(Array))
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'skipped', checkpoint: 'job_description_required' }),
    }))
  })

  it('screens out a LinkedIn destination before calling the scoring model', async () => {
    const result = await runAnalyze([{ ...job, url: 'https://www.linkedin.com/jobs/view/123' }], context())

    expect(result).toMatchObject({ ok: false, error: 'All jobs failed to score' })
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'skipped', checkpoint: 'job_preflight_failed' }),
    }))
  })
})
