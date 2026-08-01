import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@prisma/client'
import type { PipelineCtx } from '../types'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  syncGmailForUser: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: { job: { findMany: mocks.findMany } },
}))

vi.mock('@/lib/gmail-tracking/sync', () => ({
  syncGmailForUser: mocks.syncGmailForUser,
}))

import { runAudit } from './audit'

function context(emit = vi.fn()): PipelineCtx {
  return {
    userId: 'user_1',
    agentCfg: {
      id: 'config_1', userId: 'user_1', isRunning: true, dailyLimit: 10,
      minMatchScore: 70, autoApply: false, requireApproval: true,
      targetLocations: [], targetRoles: [], excludeCompanies: [], priorityCompanies: [],
      autoCoverLetter: false, coverTone: 'professional', useTailoredCV: true, model: 'MiniMax-M3',
    },
    roleConfigs: {} as PipelineCtx['roleConfigs'],
    resumeText: '',
    resumeContent: {} as PipelineCtx['resumeContent'],
    defaultResume: { id: 'resume_1', name: 'Base', templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
    aiConfig: {} as PipelineCtx['aiConfig'],
    autonomous: false,
    emit,
  }
}

const synced = {
  connected: true,
  importedMessages: 2,
  matchedMessages: 1,
  statusUpdates: 1,
  newRecommendations: 3,
  error: null,
}

describe('runAudit', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.syncGmailForUser.mockResolvedValue(synced)
  })

  it('delegates Gmail tracking to the shared durable sync service', async () => {
    const emit = vi.fn()
    const result = await runAudit({ queued: [], failed: [] }, [] as Job[], context(emit))

    expect(mocks.syncGmailForUser).toHaveBeenCalledWith('user_1')
    expect(mocks.findMany).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, data: { warnings: [] } })
    expect(emit).toHaveBeenCalledWith('agent_observation', expect.objectContaining({
      role: 'auditor',
      observation: expect.stringContaining('Gmail sync: 2 new message(s)'),
    }))
  })

  it('verifies that dispatched jobs remain queued, submitting, or confirmed submissions', async () => {
    mocks.findMany.mockResolvedValue([{
      company: 'Example Co',
      role: 'Engineer',
      status: 'saved',
      workflowState: 'queued',
    }])
    mocks.syncGmailForUser.mockResolvedValue({ ...synced, importedMessages: 0, newRecommendations: 0 })
    const emit = vi.fn()

    const result = await runAudit({ queued: ['job_1'], failed: [] }, [] as Job[], context(emit))

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['job_1'] } },
      select: expect.objectContaining({ workflowState: true }),
    }))
    expect(result).toMatchObject({ ok: true, data: { warnings: [] } })
    expect(emit).toHaveBeenCalledWith('agent_observation', expect.objectContaining({
      observation: expect.stringContaining('queued, submitting, or already confirmed submitted'),
    }))
  })

  it('accepts a job that the worker has already locked for submission', async () => {
    mocks.findMany.mockResolvedValue([{
      company: 'Example Co',
      role: 'Engineer',
      status: 'saved',
      workflowState: 'submitting',
    }])
    mocks.syncGmailForUser.mockResolvedValue({ ...synced, importedMessages: 0, newRecommendations: 0 })

    const result = await runAudit({ queued: ['job_1'], failed: [] }, [] as Job[], context())

    expect(result).toMatchObject({ ok: true, data: { warnings: [] } })
  })

  it('records a sync failure as an audit warning without changing jobs directly', async () => {
    mocks.syncGmailForUser.mockRejectedValue(new Error('network unavailable'))

    const result = await runAudit({ queued: [], failed: [] }, [] as Job[], context())

    expect(result.data?.warnings).toEqual(['Gmail sync failed: network unavailable'])
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})
