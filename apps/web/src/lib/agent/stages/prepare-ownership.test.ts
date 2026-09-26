import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  taskUpdateMany: vi.fn(),
  refreshExecutionAttempt: vi.fn(),
  coverLetterFindFirst: vi.fn(),
  coverLetterUpdate: vi.fn(),
  coverLetterCreate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))
vi.mock('../execution-control', () => ({
  refreshAgentExecutionAttempt: mocks.refreshExecutionAttempt,
  AgentExecutionCancelledError: class extends Error {
    constructor() {
      super('Agent execution was cancelled')
      this.name = 'AgentExecutionCancelledError'
    }
  },
}))

import type { PipelineCtx, ScoredJob } from '../types'
import { claimPrepareTask, markBelowThresholdSkipped, saveAgentCoverLetter, withPrepareOwnership } from './prepare-ownership'

const fence = '2026-09-26T10:00:00.001Z'
const tx = {
  applicationTask: { updateMany: mocks.taskUpdateMany },
  coverLetter: {
    findFirst: mocks.coverLetterFindFirst,
    update: mocks.coverLetterUpdate,
    create: mocks.coverLetterCreate,
  },
}

function context(withExecutionAttempt = false): PipelineCtx {
  return {
    userId: 'user_1', sessionId: 'session_1',
    ...(withExecutionAttempt ? { executionAttempt: { id: 'execution_1', attemptCount: 2 } } : {}),
  } as never
}

function scoredJob(analysisFenceAt: string | null = fence, score = 90): ScoredJob {
  return {
    job: { id: 'job_1' } as never,
    score,
    matchedKeywords: [], missingKeywords: [], recommendation: '',
    ...(analysisFenceAt === null ? {} : { analysisFenceAt }),
  }
}

describe('Prepare task ownership', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.transaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(tx))
    mocks.taskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.refreshExecutionAttempt.mockResolvedValue(true)
    mocks.coverLetterFindFirst.mockResolvedValue(null)
    mocks.coverLetterUpdate.mockResolvedValue({ id: 'cover_1' })
    mocks.coverLetterCreate.mockResolvedValue({ id: 'cover_1' })
  })

  it('fails closed without touching the database when the analysis fence is invalid', async () => {
    expect(await claimPrepareTask(scoredJob('not-a-date'), context())).toBe(false)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('claims only the exact session-scoped Analyze version', async () => {
    expect(await claimPrepareTask(scoredJob(), context(true))).toBe(true)

    expect(mocks.refreshExecutionAttempt).toHaveBeenCalledWith(tx, {
      id: 'execution_1', attemptCount: 2, userId: 'user_1',
    })
    expect(mocks.taskUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user_1', jobId: 'job_1', sessionId: 'session_1',
        status: 'analyzing', checkpoint: 'match_analysis', updatedAt: new Date(fence),
      },
      data: { status: 'generating_materials', checkpoint: 'tailoring_and_cover_letter' },
    })
  })

  it('does not transition the task when the execution attempt is stale', async () => {
    mocks.refreshExecutionAttempt.mockResolvedValue(false)

    expect(await claimPrepareTask(scoredJob(), context(true))).toBe(false)
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled()
  })

  it('allows the current execution attempt to re-enter its existing Prepare state', async () => {
    mocks.taskUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })

    expect(await claimPrepareTask(scoredJob(), context(true))).toBe(true)
    expect(mocks.taskUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        userId: 'user_1', jobId: 'job_1', sessionId: 'session_1',
        status: 'generating_materials', checkpoint: 'tailoring_and_cover_letter',
      },
      data: { status: 'generating_materials', checkpoint: 'tailoring_and_cover_letter' },
    })
  })

  it('recovers a tokenless legacy Analyze checkpoint under the current execution attempt', async () => {
    expect(await claimPrepareTask(scoredJob(null), context(true))).toBe(true)

    expect(mocks.refreshExecutionAttempt).toHaveBeenCalledWith(tx, {
      id: 'execution_1', attemptCount: 2, userId: 'user_1',
    })
    expect(mocks.taskUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user_1', jobId: 'job_1', sessionId: 'session_1',
        status: 'analyzing', checkpoint: 'match_analysis',
      },
      data: { status: 'generating_materials', checkpoint: 'tailoring_and_cover_letter' },
    })
  })

  it('re-enters a tokenless checkpoint already in Prepare only for the same session', async () => {
    mocks.taskUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })

    expect(await claimPrepareTask(scoredJob(null), context(true))).toBe(true)

    expect(mocks.taskUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        userId: 'user_1', jobId: 'job_1', sessionId: 'session_1',
        status: 'generating_materials', checkpoint: 'tailoring_and_cover_letter',
      },
      data: { status: 'generating_materials', checkpoint: 'tailoring_and_cover_letter' },
    })
  })

  it('fails closed for tokenless scores without a current attempt or session', async () => {
    const missingSession = { ...context(true), sessionId: undefined } as PipelineCtx

    expect(await claimPrepareTask(scoredJob(null), context())).toBe(false)
    expect(await claimPrepareTask(scoredJob(null), missingSession)).toBe(false)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('fails closed when a tokenless task is outside Analyze and Prepare states', async () => {
    mocks.taskUpdateMany.mockResolvedValue({ count: 0 })

    expect(await claimPrepareTask(scoredJob(null), context(true))).toBe(false)

    expect(mocks.taskUpdateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ sessionId: 'session_1', status: 'analyzing', checkpoint: 'match_analysis' }),
    }))
    expect(mocks.taskUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ sessionId: 'session_1', status: 'generating_materials', checkpoint: 'tailoring_and_cover_letter' }),
    }))
  })

  it('guards each tokenless Prepare write with the current attempt and same-session state', async () => {
    const write = vi.fn(async () => 'saved')

    await expect(withPrepareOwnership(scoredJob(undefined), context(true), write as never)).resolves.toBe('saved')

    expect(mocks.refreshExecutionAttempt).toHaveBeenCalledWith(tx, {
      id: 'execution_1', attemptCount: 2, userId: 'user_1',
    })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user_1', jobId: 'job_1', sessionId: 'session_1',
        status: 'generating_materials', checkpoint: 'tailoring_and_cover_letter',
      },
      data: { status: 'generating_materials', checkpoint: 'tailoring_and_cover_letter' },
    })
    expect(write).toHaveBeenCalledWith(tx)
  })

  it('aborts a guarded transaction when the signal fires during a pending write', async () => {
    const controller = new AbortController()
    let finishWrite!: (value: string) => void
    const write = vi.fn(() => new Promise<string>(resolve => { finishWrite = resolve }))
    const pending = withPrepareOwnership(
      scoredJob(null),
      { ...context(true), signal: controller.signal },
      write as never,
    )
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())

    controller.abort()
    finishWrite('saved')

    await expect(pending).rejects.toThrow('Agent execution was cancelled')
    expect(mocks.taskUpdateMany).toHaveBeenCalledOnce()
  })

  it('does not run a tokenless Prepare write without an attempt, session, or owned state', async () => {
    const write = vi.fn(async () => undefined)
    const missingSession = { ...context(true), sessionId: undefined } as PipelineCtx

    await expect(withPrepareOwnership(scoredJob(null), context(), write as never)).rejects.toThrow('Prepare no longer owns')
    await expect(withPrepareOwnership(scoredJob(null), missingSession, write as never)).rejects.toThrow('Prepare no longer owns')
    expect(mocks.transaction).not.toHaveBeenCalled()

    mocks.taskUpdateMany.mockResolvedValueOnce({ count: 0 })
    await expect(withPrepareOwnership(scoredJob(null), context(true), write as never)).rejects.toThrow('Prepare no longer owns')
    expect(mocks.refreshExecutionAttempt).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
  })

  it('skips a tokenless below-threshold task only under the current attempt and exact session state', async () => {
    expect(await markBelowThresholdSkipped(scoredJob(null, 50), context(true), 65)).toBe(true)

    expect(mocks.refreshExecutionAttempt).toHaveBeenCalledWith(tx, {
      id: 'execution_1', attemptCount: 2, userId: 'user_1',
    })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId: 'user_1', jobId: 'job_1', sessionId: 'session_1',
        status: 'analyzing', checkpoint: 'match_analysis',
      },
      data: expect.objectContaining({ status: 'skipped', checkpoint: 'below_match_threshold' }),
    }))
  })

  it('does not skip a tokenless task without its attempt and session scope', async () => {
    const missingSession = { ...context(true), sessionId: undefined } as PipelineCtx

    expect(await markBelowThresholdSkipped(scoredJob(null), context(), 65)).toBe(false)
    expect(await markBelowThresholdSkipped(scoredJob(null), missingSession, 65)).toBe(false)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('does not run a material write after the task leaves the Prepare checkpoint', async () => {
    mocks.taskUpdateMany.mockResolvedValue({ count: 0 })
    const write = vi.fn(async () => undefined)

    await expect(withPrepareOwnership(scoredJob(), context(true), write as never)).rejects.toThrow('Prepare no longer owns')
    expect(write).not.toHaveBeenCalled()
  })

  it('creates an agent cover letter through the supplied transaction client', async () => {
    const input = {
      userId: 'user_1', jobId: 'job_1', resumeId: 'resume_1',
      content: 'A tailored cover letter', tone: 'professional',
    }

    await expect(saveAgentCoverLetter(tx as never, input)).resolves.toEqual({ id: 'cover_1' })

    expect(mocks.coverLetterFindFirst).toHaveBeenCalledWith({
      where: { userId: 'user_1', jobId: 'job_1', resumeId: 'resume_1', origin: 'agent' },
      select: { id: true },
    })
    expect(mocks.coverLetterCreate).toHaveBeenCalledWith({
      data: {
        ...input,
        origin: 'agent',
        isFinal: false,
      },
      select: { id: true },
    })
    expect(mocks.coverLetterUpdate).not.toHaveBeenCalled()
  })

  it('updates the existing agent cover letter through the supplied transaction client', async () => {
    mocks.coverLetterFindFirst.mockResolvedValueOnce({ id: 'cover_existing' })
    const input = {
      userId: 'user_1', jobId: 'job_1', resumeId: 'resume_1',
      content: 'A refreshed cover letter', tone: 'concise',
    }

    await expect(saveAgentCoverLetter(tx as never, input)).resolves.toEqual({ id: 'cover_1' })

    expect(mocks.coverLetterUpdate).toHaveBeenCalledWith({
      where: { id: 'cover_existing' },
      data: { content: input.content, tone: input.tone, isFinal: false },
      select: { id: true },
    })
    expect(mocks.coverLetterCreate).not.toHaveBeenCalled()
  })
})
