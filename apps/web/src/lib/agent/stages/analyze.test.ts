import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@prisma/client'
import type { PipelineCtx } from '../types'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  activityCreate: vi.fn(),
  modelChat: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    job: { update: mocks.update },
    activity: { create: mocks.activityCreate },
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
  url: 'https://example.com/job', description: 'TypeScript and Node.js role.', salary: null,
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
      coverTone: 'professional', useTailoredCV: true, model: 'MiniMax-M2.7', throttleMs: 0,
    },
    roleConfigs: {
      analyst: { provider: 'minimax', model: 'MiniMax-M2.7', enabled: true },
    } as PipelineCtx['roleConfigs'],
    resumeText: 'TypeScript developer with Node.js experience.',
    resumeContent: {} as PipelineCtx['resumeContent'],
    defaultResume: { id: 'resume_1', name: 'Base resume', templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
    aiConfig: { provider: 'minimax', model: 'MiniMax-M2.7' }, autonomous: false, emit,
  }
}

describe('runAnalyze', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.update.mockResolvedValue({})
    mocks.activityCreate.mockResolvedValue({})
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
    expect(emit).toHaveBeenCalledWith('job_error', expect.objectContaining({ error: 'AI returned no JSON score' }))
  })
})
