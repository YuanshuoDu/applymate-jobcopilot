import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@prisma/client'
import type { PipelineCtx } from '../types'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
  applicationTaskUpsert: vi.fn(),
  applicationTaskUpdateMany: vi.fn(),
  modelChat: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    job: { update: mocks.update },
    activity: { create: mocks.activityCreate },
    applicationTask: { upsert: mocks.applicationTaskUpsert, updateMany: mocks.applicationTaskUpdateMany },
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
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('runAnalyze', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.update.mockResolvedValue({})
    mocks.activityCreate.mockResolvedValue({})
    mocks.applicationTaskUpsert.mockResolvedValue({ id: 'task_1' })
    mocks.applicationTaskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({
      applicationTask: { upsert: mocks.applicationTaskUpsert, updateMany: mocks.applicationTaskUpdateMany },
      job: { update: mocks.update },
      activity: { create: mocks.activityCreate },
    }))
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

  it('returns an empty successful result when a sticky checkpoint blocks refresh, without scoring or persisting', async () => {
    mocks.applicationTaskUpdateMany.mockResolvedValueOnce({ count: 0 })
    const emit = vi.fn()

    const result = await runAnalyze([job], context(emit))

    expect(result).toMatchObject({ ok: true, data: { failed: 0, scoredJobs: [] } })
    expect(mocks.applicationTaskUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {},
    }))
    expect(mocks.applicationTaskUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        userId: 'user_1',
        jobId: 'job_1',
        AND: [
          { sessionId: null },
          { OR: [
            { checkpoint: null },
            { checkpoint: { notIn: ['submission_request_started', 'submission_uncertain'] } },
          ] },
        ],
      },
      data: expect.objectContaining({ status: 'analyzing', checkpoint: 'match_analysis' }),
    })
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
            { checkpoint: { notIn: ['submission_request_started', 'submission_uncertain'] } },
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
    { status: 'filling', checkpoint: 'submission_request_started', sessionId: 'session_1' },
    { status: 'waiting_for_user', checkpoint: 'submission_uncertain', sessionId: 'session_1' },
    { status: 'analyzing', checkpoint: 'match_analysis', sessionId: 'session_2' },
  ])('drops a deferred model result after the task advances to $checkpoint', async nextState => {
    const task: { status: string; checkpoint: string | null; sessionId: string | null } = {
      status: 'queued', checkpoint: null, sessionId: 'session_1',
    }
    mocks.applicationTaskUpdateMany.mockImplementation(async rawArgs => {
      const args = rawArgs as {
        where: { status?: string; sessionId?: string | null }
        data: { status?: string; checkpoint?: string; sessionId?: string | null }
      }
      if (args.data.checkpoint === 'match_analysis') {
        const sessionMayRefresh = task.sessionId === null
          || task.sessionId === args.data.sessionId
          || args.data.sessionId === undefined
        if (!sessionMayRefresh || task.checkpoint === 'submission_request_started' || task.checkpoint === 'submission_uncertain') {
          return { count: 0 }
        }
        task.status = args.data.status ?? task.status
        task.checkpoint = args.data.checkpoint
        task.sessionId = args.data.sessionId ?? task.sessionId
        return { count: 1 }
      }

      const remainsWritable = task.status === args.where.status
        && task.sessionId === args.where.sessionId
        && task.checkpoint !== 'submission_request_started'
        && task.checkpoint !== 'submission_uncertain'
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
          { checkpoint: { notIn: ['submission_request_started', 'submission_uncertain'] } },
        ],
      }),
      data: { status: 'analyzing' },
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
            { checkpoint: { notIn: ['submission_request_started', 'submission_uncertain'] } },
          ] },
        ],
      }),
    }))
    expect(mocks.applicationTaskUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ status: 'analyzing', sessionId: null }),
    }))
    expect(mocks.modelChat).toHaveBeenCalledOnce()
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { score: 73, analysisNote: 'Good fit.' } }))
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
  })
})
