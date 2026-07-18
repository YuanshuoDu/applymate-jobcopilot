import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resumeFindFirst: vi.fn(), jobFindFirst: vi.fn(), resumeCreate: vi.fn(), activityCreate: vi.fn(),
  modelChat: vi.fn(), parseAiJson: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    resume: { findFirst: mocks.resumeFindFirst, create: mocks.resumeCreate },
    job: { findFirst: mocks.jobFindFirst },
    activity: { create: mocks.activityCreate },
  },
}))
vi.mock('@/lib/model-router', () => ({ modelChat: mocks.modelChat, parseAiJson: mocks.parseAiJson }))

import { tailorResumeForAgent } from './resume-tailoring'

describe('tailorResumeForAgent', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.resumeFindFirst.mockImplementation((args: { where: Record<string, unknown> }) => {
      if ('parentResumeId' in args.where) return null
      return { id: 'resume_1', name: 'Base CV', content: { summary: 'Backend engineer', skills: ['TypeScript'] }, templateId: 'modern', templateOptions: { accentColor: 'blue' }, directionId: null, basicsDetached: false }
    })
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', company: 'N26', role: 'Backend Engineer', description: 'TypeScript APIs and distributed systems.', keywords: 'TypeScript, APIs' })
    mocks.modelChat.mockResolvedValue({ text: '{"summary":"Backend engineer building TypeScript APIs","skills":["TypeScript","APIs"]}' })
    mocks.parseAiJson.mockReturnValue({ summary: 'Backend engineer building TypeScript APIs', skills: ['TypeScript', 'APIs'] })
    mocks.resumeCreate.mockResolvedValue({ id: 'resume_tailored', name: 'Tailored for N26 - Backend Engineer' })
    mocks.activityCreate.mockResolvedValue({})
  })

  it('creates a reviewable, job-linked resume while preserving the base template', async () => {
    const result = await tailorResumeForAgent({ userId: 'user_1', resumeId: 'resume_1', jobId: 'job_1', aiConfig: { provider: 'openai', model: 'test' } })

    expect(result).toEqual(expect.objectContaining({ id: 'resume_tailored', jobId: 'job_1', company: 'N26', reused: false }))
    expect(mocks.resumeCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: 'user_1', parentResumeId: 'resume_1', targetJobId: 'job_1', templateId: 'modern', kind: 'adapted', origin: 'ai-adapted',
    }) })
    expect(mocks.modelChat).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('Preserve truthful candidate facts') })]), expect.any(Object), 2400)
  })

  it('reuses an existing candidate artifact rather than creating a duplicate', async () => {
    mocks.resumeFindFirst.mockImplementation((args: { where: Record<string, unknown> }) => {
      if ('parentResumeId' in args.where) return { id: 'resume_existing', name: 'Tailored for N26 - Backend Engineer' }
      return { id: 'resume_1', name: 'Base CV', content: {}, templateId: null, templateOptions: null, directionId: null, basicsDetached: false }
    })

    await expect(tailorResumeForAgent({ userId: 'user_1', resumeId: 'resume_1', jobId: 'job_1', aiConfig: { provider: 'openai', model: 'test' } }))
      .resolves.toEqual(expect.objectContaining({ id: 'resume_existing', reused: true }))
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
  })
})
