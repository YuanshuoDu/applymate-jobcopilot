import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineCtx } from '../types'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
  activityCreate: vi.fn(),
  discoverJobs: vi.fn(),
  transaction: vi.fn(),
  transactionCommits: 0,
  refreshExecutionAttempt: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    job: { findMany: mocks.findMany, create: mocks.create },
    activity: { create: mocks.activityCreate },
  },
}))

vi.mock('@/lib/agent/discover', () => ({ discoverJobs: mocks.discoverJobs }))
vi.mock('../execution-control', () => ({
  AgentExecutionCancelledError: class extends Error {
    constructor() { super('Agent execution was cancelled'); this.name = 'AgentExecutionCancelledError' }
  },
  refreshAgentExecutionAttempt: mocks.refreshExecutionAttempt,
}))

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
    mocks.create.mockResolvedValue({ id: 'job_1' })
    mocks.refreshExecutionAttempt.mockResolvedValue(true)
    mocks.transactionCommits = 0
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const result = await work({ job: { create: mocks.create }, activity: { create: mocks.activityCreate } })
      mocks.transactionCommits += 1
      return result
    })
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
    expect(mocks.refreshExecutionAttempt).not.toHaveBeenCalled()
  })

  it('fences every discovered job and activity write in its transaction', async () => {
    const transactions: unknown[] = []
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = { job: { create: mocks.create }, activity: { create: mocks.activityCreate } }
      transactions.push(tx)
      return work(tx)
    })
    const ctx = {
      ...context(),
      executionAttempt: { id: 'execution_1', attemptCount: 8 },
      signal: new AbortController().signal,
    }

    const result = await runScout(ctx)

    expect(result).toMatchObject({ ok: true, data: { discovered: 2 } })
    expect(mocks.transaction).toHaveBeenCalledTimes(3)
    expect(mocks.refreshExecutionAttempt).toHaveBeenCalledTimes(3)
    for (const [tx, owner] of mocks.refreshExecutionAttempt.mock.calls) {
      expect(transactions).toContain(tx)
      expect(owner).toEqual({ id: 'execution_1', attemptCount: 8, userId: 'user_1' })
    }
  })

  it('throws cancellation and skips activity when the execution attempt is stale', async () => {
    mocks.refreshExecutionAttempt.mockResolvedValue(false)
    const ctx = { ...context(), executionAttempt: { id: 'execution_1', attemptCount: 8 } }

    await expect(runScout(ctx)).rejects.toMatchObject({ name: 'AgentExecutionCancelledError' })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.findMany).toHaveBeenCalledOnce()
  })

  it('returns an ordinary Scout failure when the ownership refresh database call rejects', async () => {
    mocks.refreshExecutionAttempt.mockRejectedValue(new Error('database unavailable'))
    const ctx = { ...context(), executionAttempt: { id: 'execution_1', attemptCount: 8 } }

    const result = await runScout(ctx)

    expect(result).toMatchObject({ ok: false, error: 'Scout failed: Scout ownership check failed: database unavailable' })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.transactionCommits).toBe(0)
    expect(mocks.findMany).toHaveBeenCalledOnce()
  })

  it('rolls back discovery writes if the signal aborts during persistence', async () => {
    const controller = new AbortController()
    mocks.create.mockImplementationOnce(async () => {
      controller.abort()
      return { id: 'job_1' }
    })
    const ctx = {
      ...context(),
      executionAttempt: { id: 'execution_1', attemptCount: 8 },
      signal: controller.signal,
    }

    await expect(runScout(ctx)).rejects.toMatchObject({ name: 'AgentExecutionCancelledError' })
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.transactionCommits).toBe(0)
    expect(mocks.findMany).toHaveBeenCalledOnce()
  })
})
