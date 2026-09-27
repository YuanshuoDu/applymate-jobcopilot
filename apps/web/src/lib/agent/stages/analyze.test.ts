import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@prisma/client'
import type { PipelineCtx } from '../types'
import { AgentExecutionCancelledError } from '../execution-control'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
  applicationTaskUpsert: vi.fn(),
  applicationTaskFindUnique: vi.fn(),
  applicationTaskUpdateMany: vi.fn(),
  executionUpdateMany: vi.fn(),
  modelChat: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    job: { update: mocks.update },
    activity: { create: mocks.activityCreate },
    applicationTask: {
      upsert: mocks.applicationTaskUpsert,
      findUnique: mocks.applicationTaskFindUnique,
      updateMany: mocks.applicationTaskUpdateMany,
    },
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('runAnalyze', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.update.mockResolvedValue({})
    mocks.activityCreate.mockResolvedValue({})
    mocks.applicationTaskUpsert.mockResolvedValue({ id: 'task_1' })
    mocks.applicationTaskFindUnique.mockResolvedValue({ updatedAt: new Date('2026-01-01T00:00:00.000Z') })
    mocks.applicationTaskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.executionUpdateMany.mockResolvedValue({ count: 1 })
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({
      applicationTask: {
        upsert: mocks.applicationTaskUpsert,
        findUnique: mocks.applicationTaskFindUnique,
        updateMany: mocks.applicationTaskUpdateMany,
      },
      job: { update: mocks.update },
      activity: { create: mocks.activityCreate },
      agentExecution: { updateMany: mocks.executionUpdateMany },
    }))
  })

  it('persists a structured AI score using a completion budget that supports reasoning models', async () => {
    mocks.modelChat.mockResolvedValue({
      text: '{"score":73,"matchedKeywords":["TypeScript"],"missingKeywords":["AWS"],"recommendation":"Add cloud experience."}',
    })

    const result = await runAnalyze([job], context())

    expect(result).toMatchObject({ ok: true, data: { failed: 0, scoredJobs: [{ score: 73 }] } })
    const claimedFenceAt = (mocks.applicationTaskUpdateMany.mock.calls[0][0] as { data: { updatedAt: Date } }).data.updatedAt
    expect(mocks.applicationTaskUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: { status: 'analyzing', updatedAt: claimedFenceAt },
    }))
    expect(result).toMatchObject({ data: { scoredJobs: [{ analysisFenceAt: claimedFenceAt.toISOString() }] } })
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

  it.each([
    { label: 'preflight', input: { ...job, url: 'https://www.linkedin.com/jobs/view/123' } },
    { label: 'missing job data', input: { ...job, role: null, description: null } },
    { label: 'candidate skip', input: { ...job, description: null } },
  ])('does not emit a stale $label skip when its task transition loses ownership', async ({ input, label }) => {
    mocks.applicationTaskUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
    const emit = vi.fn()
    const ctx = context(emit)
    if (label === 'candidate skip') ctx.askUser = vi.fn().mockResolvedValue('skip_no_desc')

    const result = await runAnalyze([input as Job], ctx)

    expect(result).toMatchObject({ ok: true, data: { failed: 0, scoredJobs: [] } })
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('returns an empty successful result when a sticky checkpoint blocks refresh, without scoring or persisting', async () => {
    mocks.applicationTaskUpdateMany.mockResolvedValueOnce({ count: 0 })
    const emit = vi.fn()

    const result = await runAnalyze([job], context(emit))

    expect(result).toMatchObject({ ok: true, data: { failed: 0, scoredJobs: [] } })
    expect(mocks.applicationTaskUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {},
    }))
    expect(mocks.applicationTaskUpdateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        userId: 'user_1',
        jobId: 'job_1',
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        OR: [
          { status: { in: ['discovered', 'analyzing'] } },
          { status: 'failed', checkpoint: 'match_analysis_failed' },
        ],
        AND: [
          { sessionId: null },
          { OR: [
            { checkpoint: null },
            { checkpoint: { notIn: ['submission_request_started', 'submission_uncertain', 'turn_stopped_before_submit'] } },
          ] },
        ],
      }),
      data: expect.objectContaining({ status: 'analyzing', checkpoint: 'match_analysis' }),
    }))
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('does not let a sessionless Analyze claim a task owned by another V2 session', async () => {
    mocks.applicationTaskUpdateMany.mockResolvedValueOnce({ count: 0 })
    const emit = vi.fn()

    const result = await runAnalyze([job], context(emit))

    expect(result).toMatchObject({ ok: true, data: { failed: 0, scoredJobs: [] } })
    expect(mocks.applicationTaskUpdateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          { sessionId: null },
          { OR: [
            { checkpoint: null },
            { checkpoint: { notIn: ['submission_request_started', 'submission_uncertain', 'turn_stopped_before_submit'] } },
          ] },
        ]),
      }),
    }))
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'cancelled', checkpoint: 'turn_stopped_before_submit' },
    { status: 'submitted', checkpoint: 'submission_verified' },
    { status: 'waiting_for_authorization', checkpoint: 'form_filled' },
    { status: 'filling', checkpoint: 'browser_active' },
    { status: 'failed', checkpoint: 'account_suspended' },
    { status: 'failed', checkpoint: 'execution_failed' },
    { status: 'failed', checkpoint: 'admin_retry_failed' },
  ])('does not reopen protected application state $status/$checkpoint', async taskState => {
    const taskUpdatedAt = new Date('2026-01-01T00:00:00.000Z')
    mocks.applicationTaskFindUnique.mockResolvedValue({ updatedAt: taskUpdatedAt })
    mocks.applicationTaskUpdateMany.mockImplementationOnce(rawArgs => {
      const args = rawArgs as { where: { OR?: Array<{ status?: { in?: string[] } | string; checkpoint?: string }> } }
      const canAnalyze = args.where.OR?.some(state =>
        typeof state.status === 'object'
          ? state.status.in?.includes(taskState.status)
          : state.status === taskState.status && state.checkpoint === taskState.checkpoint,
      )
      return Promise.resolve({ count: canAnalyze ? 1 : 0 })
    })
    const ctx = context()
    ctx.sessionId = 'session_1'

    const result = await runAnalyze([job], ctx)

    expect(result).toMatchObject({ ok: true, data: { failed: 0, scoredJobs: [] } })
    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { status: { in: ['discovered', 'analyzing'] } },
          { status: 'failed', checkpoint: 'match_analysis_failed' },
        ],
        updatedAt: taskUpdatedAt,
      }),
    }))
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('re-analyzes failures owned by Analyze without reopening other failure states', async () => {
    mocks.modelChat.mockResolvedValue({
      text: '{"score":73,"matchedKeywords":["TypeScript"],"missingKeywords":[],"recommendation":"Good fit."}',
    })
    const taskUpdatedAt = new Date('2026-01-01T00:00:00.000Z')
    mocks.applicationTaskFindUnique.mockResolvedValue({ updatedAt: taskUpdatedAt })

    await runAnalyze([job], context())

    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [
        { status: { in: ['discovered', 'analyzing'] } },
        { status: 'failed', checkpoint: 'match_analysis_failed' },
      ] }),
    }))
    expect(mocks.modelChat).toHaveBeenCalledOnce()
  })

  it('drops an older model result after a later Analyze attempt claims the task', async () => {
    const task = {
      status: 'analyzing',
      checkpoint: 'match_analysis',
      sessionId: 'session_1',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }
    mocks.applicationTaskFindUnique.mockImplementation(async () => ({ updatedAt: task.updatedAt }))
    mocks.applicationTaskUpdateMany.mockImplementation(async rawArgs => {
      const args = rawArgs as {
        where: { OR?: Array<{ status?: string | { in?: string[] }; checkpoint?: string }>; status?: string; updatedAt?: Date }
        data: { status?: string; checkpoint?: string; updatedAt?: Date }
      }
      const canAnalyze = args.where.OR?.some(state => typeof state.status === 'object'
        ? state.status.in?.includes(task.status)
        : state.status === task.status && state.checkpoint === task.checkpoint)
      if (args.data.checkpoint === 'match_analysis') {
        const versionMatches = args.where.updatedAt?.getTime() === task.updatedAt.getTime()
        if (!versionMatches || !canAnalyze) return { count: 0 }
        task.status = args.data.status ?? task.status
        task.checkpoint = args.data.checkpoint ?? task.checkpoint
        task.updatedAt = args.data.updatedAt ?? task.updatedAt
        return { count: 1 }
      }
      const versionMatches = args.where.updatedAt?.getTime() === task.updatedAt.getTime()
      if (!versionMatches || task.status !== args.where.status) return { count: 0 }
      task.updatedAt = args.data.updatedAt ?? new Date(task.updatedAt.getTime() + 1)
      return { count: 1 }
    })
    const pendingOlderModel = deferred<{ text: string }>()
    let markOlderModelStarted!: () => void
    const olderModelStarted = new Promise<void>(resolve => { markOlderModelStarted = resolve })
    mocks.modelChat
      .mockImplementationOnce(() => {
        markOlderModelStarted()
        return pendingOlderModel.promise
      })
      .mockResolvedValueOnce({
        text: '{"score":81,"matchedKeywords":["TypeScript"],"missingKeywords":[],"recommendation":"Good fit."}',
      })
    const emit = vi.fn()
    const ctx = context(emit)
    ctx.sessionId = 'session_1'

    const olderAttempt = runAnalyze([job], ctx)
    await olderModelStarted
    const newerResult = await runAnalyze([job], ctx)
    pendingOlderModel.resolve({
      text: '{"score":91,"matchedKeywords":["TypeScript"],"missingKeywords":[],"recommendation":"Strong fit."}',
    })
    const olderResult = await olderAttempt

    expect(mocks.modelChat).toHaveBeenCalledTimes(2)
    expect(newerResult).toMatchObject({ ok: true, data: { scoredJobs: [{ score: 81 }] } })
    expect(olderResult).toMatchObject({ ok: true, data: { scoredJobs: [] } })
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { score: 81, analysisNote: 'Good fit.' } }))
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith('job_done', expect.objectContaining({ score: 81 }))
    expect(emit).not.toHaveBeenCalledWith('job_done', expect.objectContaining({ score: 91 }))
  })

  it('drops a model result after its AgentExecution attempt is reclaimed before the next task claim', async () => {
    let currentAttempt = 1
    mocks.executionUpdateMany.mockImplementation(async rawArgs => {
      const args = rawArgs as { where: { attemptCount?: number } }
      return { count: args.where.attemptCount === currentAttempt ? 1 : 0 }
    })
    const pendingModel = deferred<{ text: string }>()
    let markModelStarted!: () => void
    const modelStarted = new Promise<void>(resolve => { markModelStarted = resolve })
    mocks.modelChat.mockImplementationOnce(() => {
      markModelStarted()
      return pendingModel.promise
    })
    const emit = vi.fn()
    const ctx = context(emit)
    ctx.sessionId = 'session_1'
    ctx.executionAttempt = { id: 'execution_1', attemptCount: 1 }
    const resultPromise = runAnalyze([job], ctx)

    await modelStarted
    currentAttempt = 2
    pendingModel.resolve({
      text: '{"score":91,"matchedKeywords":["TypeScript"],"missingKeywords":[],"recommendation":"Strong fit."}',
    })

    const result = await resultPromise

    expect(result).toMatchObject({ ok: true, data: { scoredJobs: [] } })
    expect(mocks.executionUpdateMany).toHaveBeenCalledTimes(2)
    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalledWith('job_done', expect.anything())
  })

  it('does not emit a scoring error when the AgentExecution attempt is reclaimed before its failure transition', async () => {
    let refreshCount = 0
    mocks.executionUpdateMany.mockImplementation(async () => ({ count: ++refreshCount === 1 ? 1 : 0 }))
    mocks.modelChat.mockRejectedValue(new Error('provider unavailable'))
    const emit = vi.fn()
    const ctx = context(emit)
    ctx.sessionId = 'session_1'
    ctx.executionAttempt = { id: 'execution_1', attemptCount: 1 }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await runAnalyze([job], ctx)
    consoleError.mockRestore()

    expect(result).toMatchObject({ ok: true, data: { failed: 0, scoredJobs: [] } })
    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledOnce()
    expect(consoleError).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalledWith('job_error', expect.anything())
    expect(emit).not.toHaveBeenCalledWith('agent_observation', expect.anything())
  })

  it('does not persist a deferred score or failure after its signal aborts', async () => {
    const controller = new AbortController()
    const pendingModel = deferred<{ text: string }>()
    let markModelStarted!: () => void
    const modelStarted = new Promise<void>(resolve => { markModelStarted = resolve })
    mocks.modelChat.mockImplementationOnce(() => {
      markModelStarted()
      return pendingModel.promise
    })
    const emit = vi.fn()
    const ctx = context(emit)
    ctx.sessionId = 'session_1'
    ctx.executionAttempt = { id: 'execution_1', attemptCount: 1 }
    ctx.signal = controller.signal
    const resultPromise = runAnalyze([job], ctx)

    await modelStarted
    controller.abort()
    pendingModel.resolve({
      text: '{"score":91,"matchedKeywords":["TypeScript"],"missingKeywords":[],"recommendation":"Strong fit."}',
    })

    await expect(resultPromise).rejects.toBeInstanceOf(AgentExecutionCancelledError)
    expect(mocks.executionUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'analyzing', checkpoint: 'match_analysis' }),
    }))
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalledWith('job_done', expect.anything())
    expect(emit).not.toHaveBeenCalledWith('job_error', expect.anything())
  })

  it.each([
    { status: 'filling', checkpoint: 'submission_request_started', sessionId: 'session_1' },
    { status: 'waiting_for_user', checkpoint: 'submission_uncertain', sessionId: 'session_1' },
    { status: 'cancelled', checkpoint: 'turn_stopped_before_submit', sessionId: 'session_1' },
    { status: 'analyzing', checkpoint: 'match_analysis', sessionId: 'session_2' },
  ])('drops a deferred model result after the task advances to $checkpoint', async nextState => {
    const task: { status: string; checkpoint: string | null; sessionId: string | null; updatedAt: Date } = {
      status: 'discovered', checkpoint: null, sessionId: 'session_1', updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }
    mocks.applicationTaskFindUnique.mockImplementation(async () => ({ updatedAt: task.updatedAt }))
    mocks.applicationTaskUpdateMany.mockImplementation(async rawArgs => {
      const args = rawArgs as {
        where: { OR?: Array<{ status?: string | { in?: string[] }; checkpoint?: string }>; status?: string; sessionId?: string | null; updatedAt?: Date }
        data: { status?: string; checkpoint?: string; sessionId?: string | null; updatedAt?: Date }
      }
      if (args.data.checkpoint === 'match_analysis') {
        const allowedStatuses = args.where.OR?.some(state => typeof state.status === 'object'
          ? state.status.in?.includes(task.status)
          : state.status === task.status && state.checkpoint === task.checkpoint)
        const sessionMayRefresh = task.sessionId === null
          || task.sessionId === args.data.sessionId
          || args.data.sessionId === undefined
        const versionMatches = args.where.updatedAt?.getTime() === task.updatedAt.getTime()
        if (!sessionMayRefresh || !allowedStatuses || !versionMatches
          || ['submission_request_started', 'submission_uncertain', 'turn_stopped_before_submit'].includes(task.checkpoint ?? '')) {
          return { count: 0 }
        }
        task.status = args.data.status ?? task.status
        task.checkpoint = args.data.checkpoint
        task.sessionId = args.data.sessionId ?? task.sessionId
        task.updatedAt = args.data.updatedAt ?? task.updatedAt
        return { count: 1 }
      }

      const remainsWritable = task.status === args.where.status
        && task.sessionId === args.where.sessionId
        && task.checkpoint === 'match_analysis'
        && args.where.updatedAt?.getTime() === task.updatedAt.getTime()
        && !['submission_request_started', 'submission_uncertain', 'turn_stopped_before_submit'].includes(task.checkpoint ?? '')
      return { count: remainsWritable ? 1 : 0 }
    })

    const pendingModel = deferred<{ text: string }>()
    let markModelStarted!: () => void
    const modelStarted = new Promise<void>(resolve => { markModelStarted = resolve })
    mocks.modelChat.mockImplementationOnce(() => {
      markModelStarted()
      return pendingModel.promise
    })
    const emit = vi.fn()
    const ctx = context(emit)
    ctx.sessionId = 'session_1'
    const resultPromise = runAnalyze([job], ctx)

    await modelStarted
    expect(mocks.modelChat).toHaveBeenCalledOnce()
    expect(task).toMatchObject({ status: 'analyzing', checkpoint: 'match_analysis', sessionId: 'session_1' })
    task.status = nextState.status
    task.checkpoint = nextState.checkpoint
    task.sessionId = nextState.sessionId
    task.updatedAt = new Date(task.updatedAt.getTime() + 1)
    pendingModel.resolve({
      text: '{"score":91,"matchedKeywords":["TypeScript"],"missingKeywords":[],"recommendation":"Strong fit."}',
    })

    const result = await resultPromise

    expect(result).toMatchObject({ ok: true, data: { failed: 0, scoredJobs: [] } })
    expect(mocks.applicationTaskUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        userId: 'user_1', jobId: 'job_1', status: 'analyzing', sessionId: 'session_1',
        OR: [
          { checkpoint: null },
          { checkpoint: { notIn: ['submission_request_started', 'submission_uncertain', 'turn_stopped_before_submit'] } },
        ],
      }),
      data: { status: 'analyzing', updatedAt: expect.any(Date) },
    }))
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalledWith('job_done', expect.anything())
    expect(emit).not.toHaveBeenCalledWith('agent_observation', expect.anything())
  })

  it('continues analysis for a legacy task with NULL sessionId and checkpoint', async () => {
    mocks.applicationTaskUpdateMany.mockResolvedValueOnce({ count: 1 })
    mocks.modelChat.mockResolvedValue({
      text: '{"score":73,"matchedKeywords":["TypeScript"],"missingKeywords":[],"recommendation":"Good fit."}',
    })

    const result = await runAnalyze([job], context())

    expect(result).toMatchObject({ ok: true, data: { failed: 0, scoredJobs: [{ score: 73 }] } })
    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: [
          { sessionId: null },
          { OR: [
            { checkpoint: null },
            { checkpoint: { notIn: ['submission_request_started', 'submission_uncertain', 'turn_stopped_before_submit'] } },
          ] },
        ],
      }),
    }))
    expect(mocks.applicationTaskUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ status: 'analyzing', sessionId: null }),
      data: expect.objectContaining({ updatedAt: expect.any(Date) }),
    }))
    expect(mocks.modelChat).toHaveBeenCalledOnce()
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { score: 73, analysisNote: 'Good fit.' } }))
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
  })
})
