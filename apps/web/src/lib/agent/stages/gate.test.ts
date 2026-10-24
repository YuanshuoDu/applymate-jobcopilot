import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationPackage, PipelineCtx } from '../types'

const mocks = vi.hoisted(() => ({ createGateReviewReceipt: vi.fn(), findGateReviewReceiptReplay: vi.fn(), skipApplicationForGate: vi.fn(), modelChat: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/model-router', () => ({ modelChat: mocks.modelChat }))
vi.mock('../execution-control', () => ({ AgentExecutionCancelledError: class AgentExecutionCancelledError extends Error {
  constructor() { super('Agent execution was cancelled'); this.name = 'AgentExecutionCancelledError' }
} }))
vi.mock('../application-control', () => ({ skipApplicationForGate: mocks.skipApplicationForGate }))
vi.mock('./gate-review-receipt', () => ({ createGateReviewReceipt: mocks.createGateReviewReceipt, findGateReviewReceiptReplay: mocks.findGateReviewReceiptReplay }))
vi.mock('./prepare', () => ({ tailoringConstraints: vi.fn(() => ({})) }))

import { runGate, runScheduledGate } from './gate'
import { createScheduledTaskGraphGateQuestion } from '../scheduled-taskgraph-gate-service'

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

function packageFor(score: number, tailoredResumeId?: string, jobId = 'job_1'): ApplicationPackage {
  return {
    job: { id: jobId, company: jobId === 'job_1' ? 'Example' : 'Example ' + jobId, role: 'Cyber Security Analyst', description: null } as ApplicationPackage['job'],
    score, matchedKeywords: ['SOC'], missingKeywords: [], recommendation: '', tailoredResumeId,
  }
}

function draftArtifact(constraintHash: string) {
  return {
    id: 'resume:draft', kind: 'resume' as const, lifecycle: 'draft' as const, version: 1,
    hash: 'sha256:' + 'a'.repeat(64), baseArtifactId: 'resume_1', baseHash: 'sha256:' + 'b'.repeat(64),
    constraintHash, provenance: [{ sourceType: 'resume' as const, sourceRef: 'resume:resume_1', evidenceHash: 'sha256:' + 'b'.repeat(64) }],
  }
}

beforeEach(() => {
  mocks.createGateReviewReceipt.mockReset()
  mocks.createGateReviewReceipt.mockResolvedValue({ projectedWait: true, receipt: { id: 'approval_1' } })
  mocks.findGateReviewReceiptReplay.mockReset()
  mocks.findGateReviewReceiptReplay.mockResolvedValue(null)
  mocks.skipApplicationForGate.mockReset()
  mocks.skipApplicationForGate.mockResolvedValue(true)
  mocks.modelChat.mockReset()
})

describe('runGate', () => {
  it('keeps an unavailable quality review pending and explains the human-review fallback', async () => {
    const ctx = context()
    const base = packageFor(75)
    const pkg = {
      ...base,
      coverLetter: 'A draft cover letter.',
      job: { ...base.job, description: 'Incident response role.' },
    }
    mocks.modelChat.mockRejectedValue(new Error('provider-secret-detail'))

    const result = await runGate([pkg], ctx)

    expect(result.data?.approved).toHaveLength(0)
    expect(result.data?.pending).toHaveLength(1)
    expect(result.data?.skipped).toHaveLength(0)
    expect(mocks.skipApplicationForGate).not.toHaveBeenCalled()
    expect(ctx.emit).toHaveBeenCalledWith('agent_observation', {
      role: 'reviewer',
      observation: 'AI quality review did not complete; no quality result was produced. Normal match-threshold and material checks still apply; only eligible packages continue to human review.',
    })
    expect(ctx.emit).not.toHaveBeenCalledWith('agent_observation', expect.objectContaining({
      observation: expect.stringContaining('provider-secret-detail'),
    }))
    expect(ctx.emit).toHaveBeenCalledWith('agent_question', expect.objectContaining({
      questionId: 'application_review_job_1',
    }))
  })

  it('applies the existing below-threshold skip after an unavailable quality review', async () => {
    const ctx = context()
    const base = packageFor(49)
    const pkg = {
      ...base,
      coverLetter: 'A draft cover letter.',
      job: { ...base.job, description: 'Incident response role.' },
    }
    mocks.modelChat.mockRejectedValue(new Error('provider-secret-detail'))

    const result = await runGate([pkg], ctx)

    expect(result.data?.pending).toHaveLength(0)
    expect(result.data?.skipped).toHaveLength(1)
    expect(mocks.skipApplicationForGate).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: 'below_match_threshold',
    }))
    expect(ctx.emit).toHaveBeenCalledWith('agent_observation', {
      role: 'reviewer',
      observation: 'AI quality review did not complete; no quality result was produced. Normal match-threshold and material checks still apply; only eligible packages continue to human review.',
    })
    expect(ctx.emit).not.toHaveBeenCalledWith('agent_observation', expect.objectContaining({
      observation: expect.stringContaining('pending'),
    }))
  })

  it('keeps a threshold-matching tailored resume in review even when autopilot is configured', async () => {
    const result = await runGate([packageFor(75, 'tailored_1')], context())
    expect(result.data?.approved).toHaveLength(0)
    expect(result.data?.pending).toHaveLength(1)
  })

  it('keeps the low-score clarification for a valid quality result', async () => {
    const ctx = context()
    ctx.askUser = vi.fn().mockResolvedValue('review')
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({
      clScore: 4, fitGap: 'missing evidence', recommendation: 'add evidence', readyToApply: false,
    }) })

    const result = await runGate([{ ...packageFor(75), coverLetter: 'A draft cover letter.' }], ctx)

    expect(ctx.askUser).toHaveBeenCalledWith('reviewer', expect.stringContaining('quality is low(4/10)'), expect.any(Array))
    expect(result.data?.pending).toHaveLength(1)
    expect(result.data?.skipped).toHaveLength(0)
  })

  it('marks a below-threshold package as skipped by default', async () => {
    const result = await runGate([packageFor(49, 'tailored_1')], context())
    expect(result.data?.approved).toHaveLength(0)
    expect(result.data?.pending).toHaveLength(0)
    expect(result.data?.skipped).toHaveLength(1)
  })

  it('fences below-threshold task updates to the exact pipeline owner', async () => {
    const ctx = context()
    Object.assign(ctx, { sessionId: 'session_1', turnId: 'turn_1', executionAttempt: { id: 'execution_1', attemptCount: 2 } })

    await runGate([packageFor(49, 'tailored_1')], ctx)

    expect(mocks.skipApplicationForGate).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session_1',
      checkpoint: 'below_match_threshold',
      owner: expect.objectContaining({ turnId: 'turn_1', executionAttempt: { id: 'execution_1', attemptCount: 2 } }),
    }))
  })

  it('pauses for a candidate-approved borderline exception before holding it for review', async () => {
    const ctx = context({ autoApply: false, requireApproval: true })
    ctx.askUser = vi.fn().mockResolvedValue('add_to_pending')
    const result = await runGate([packageFor(49, 'tailored_1')], ctx)
    expect(result.data?.pending).toHaveLength(1)
    expect(result.data?.skipped).toHaveLength(0)
    expect(ctx.askUser).toHaveBeenCalledWith('reviewer', expect.any(String), expect.any(Array))
  })

  it('stales an artifact when Agent tailoring constraints changed', async () => {
    const ctx = context()
    const result = await runGate([{ ...packageFor(75, 'tailored_1'), tailoredResumeArtifact: draftArtifact('sha256:' + 'c'.repeat(64)) }], ctx)
    expect(result.data?.pending).toHaveLength(0)
    expect(result.data?.skipped).toHaveLength(1)
    expect(ctx.emit).toHaveBeenCalledWith('artifact_reviewed', expect.objectContaining({ status: 'stale' }))
  })

  it('routes review receipts through the exact pipeline Turn', async () => {
    const ctx = context()
    Object.assign(ctx, { sessionId: 'session_1', turnId: 'turn_1', executionAttempt: { id: 'execution_1', attemptCount: 3 } })

    await runGate([packageFor(75, 'tailored_1')], ctx)

    expect(mocks.createGateReviewReceipt).toHaveBeenCalledWith(ctx, expect.objectContaining({ job: expect.objectContaining({ id: 'job_1' }) }), false)
    expect(ctx.emit).toHaveBeenCalledWith('application_review_ready', { approval: { id: 'approval_1' } })
    expect(ctx.emit).toHaveBeenCalledWith('agent_question', expect.objectContaining({
      questionId: 'application_review_job_1',
      question: expect.stringContaining('The job and prepared materials are ready for review.'),
    }))
    expect(ctx.emit).not.toHaveBeenCalledWith('agent_question', expect.objectContaining({ question: expect.stringContaining('cover letter') }))
    expect(ctx.emit).not.toHaveBeenCalledWith('agent_question', expect.objectContaining({ question: expect.stringContaining('answers') }))
  })

  it('emits no review wait or approval-ready event when Stop wins the receipt fence', async () => {
    const ctx = context()
    Object.assign(ctx, { sessionId: 'session_1', turnId: 'turn_1', executionAttempt: { id: 'execution_1', attemptCount: 3 } })
    mocks.createGateReviewReceipt.mockRejectedValueOnce(Object.assign(new Error('Agent execution was cancelled'), { name: 'AgentExecutionCancelledError' }))

    await expect(runGate([packageFor(75, 'tailored_1')], ctx)).rejects.toMatchObject({ name: 'AgentExecutionCancelledError' })

    expect(ctx.emit).not.toHaveBeenCalledWith('application_review_ready', expect.anything())
    expect(ctx.emit).not.toHaveBeenCalledWith('agent_question', expect.objectContaining({ questionId: 'application_review_job_1' }))
  })

  it('does not skip a task or emit follow-up state when Stop wins during the reviewer decision', async () => {
    const abortController = new AbortController()
    const ctx = context()
    Object.assign(ctx, {
      sessionId: 'session_1',
      turnId: 'turn_1',
      executionAttempt: { id: 'execution_1', attemptCount: 3 },
      signal: abortController.signal,
    })
    let resolveDecision!: (decision: string) => void
    const decision = new Promise<string>(resolve => { resolveDecision = resolve })
    ctx.askUser = vi.fn(() => decision)
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ clScore: 4, fitGap: 'missing evidence', recommendation: 'add evidence', readyToApply: false }) })
    mocks.skipApplicationForGate.mockImplementation(async input => {
      if (input.owner?.signal?.aborted) throw Object.assign(new Error('Agent execution was cancelled'), { name: 'AgentExecutionCancelledError' })
      return true
    })

    const run = runGate([{ ...packageFor(75), coverLetter: 'A short draft' }], ctx)
    await vi.waitFor(() => expect(ctx.askUser).toHaveBeenCalled())
    abortController.abort()
    resolveDecision('skip')

    await expect(run).rejects.toMatchObject({ name: 'AgentExecutionCancelledError' })
    expect(mocks.skipApplicationForGate).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_1',
      jobId: 'job_1',
      checkpoint: 'review_quality_declined',
      owner: expect.objectContaining({ turnId: 'turn_1', executionAttempt: { id: 'execution_1', attemptCount: 3 }, signal: abortController.signal }),
    }))
    expect(ctx.emit).not.toHaveBeenCalledWith('application_review_ready', expect.anything())
    expect(ctx.emit).not.toHaveBeenCalledWith('agent_observation', expect.objectContaining({ observation: expect.stringContaining('✕ jump over') }))
  })
})

describe('runScheduledGate', () => {
  it('returns a bounded weak-letter question without invoking child askUser or emitting its body', async () => {
    const ctx = context()
    ctx.askUser = vi.fn()
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ clScore: 4, fitGap: 'missing evidence', recommendation: 'add evidence', readyToApply: false }) })

    const result = await runScheduledGate([{ ...packageFor(75), coverLetter: 'Private letter body' }], ctx)

    expect(result).toEqual(createScheduledTaskGraphGateQuestion('weak_cover_letter', ['job_1']))
    expect(ctx.askUser).not.toHaveBeenCalled()
    expect(ctx.emit).not.toHaveBeenCalledWith('agent_question', expect.anything())
    expect(mocks.createGateReviewReceipt).not.toHaveBeenCalled()
  })

  it('applies only a matching validated fixed choice and projects decision IDs', async () => {
    const ctx = context()
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ clScore: 4, fitGap: 'missing evidence', recommendation: 'add evidence', readyToApply: false }) })
    const question = createScheduledTaskGraphGateQuestion('weak_cover_letter', ['job_1'])!
    const choice = { kind: question.kind, jobIds: question.jobIds, choiceId: 'skip' }

    const result = await runScheduledGate([{ ...packageFor(75), coverLetter: 'Private letter body' }], ctx, choice)

    expect(result).toEqual({ status: 'completed', nextStage: 'execute', approvedJobIds: [], pendingJobIds: [], skippedJobIds: ['job_1'],
      counts: { approved: 0, pending: 0, skipped: 1 } })
    expect(mocks.skipApplicationForGate).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job_1', checkpoint: 'review_quality_declined' }))
  })

  it.each(['skip', 'review', 'continue'] as const)('honors the bound %s choice when a fresh quality score no longer asks the question', async choiceId => {
    const ctx = context()
    Object.assign(ctx, { sessionId: 'session_1', turnId: 'turn_1', executionAttempt: { id: 'execution_1', attemptCount: 4 } })
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ clScore: 9, fitGap: 'private quality detail', recommendation: 'private model recommendation', readyToApply: true }) })
    const question = createScheduledTaskGraphGateQuestion('weak_cover_letter', ['job_1'])!

    const result = await runScheduledGate([{ ...packageFor(75), coverLetter: 'Private letter body' }], ctx,
      { kind: question.kind, jobIds: question.jobIds, choiceId })

    expect(result).toMatchObject(choiceId === 'skip'
      ? { status: 'completed', skippedJobIds: ['job_1'], counts: { skipped: 1 } }
      : { status: 'completed', pendingJobIds: ['job_1'], counts: { pending: 1 } })
    expect(mocks.modelChat).toHaveBeenCalledOnce()
    if (choiceId === 'skip') {
      expect(mocks.skipApplicationForGate).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job_1', checkpoint: 'review_quality_declined' }))
      expect(mocks.createGateReviewReceipt).not.toHaveBeenCalled()
    } else expect(mocks.createGateReviewReceipt).toHaveBeenCalledOnce()
  })

  it('rejects a supplied choice that matches no server-derived question before doing work', async () => {
    const ctx = context()
    const question = createScheduledTaskGraphGateQuestion('weak_cover_letter', ['unknown_job'])!

    await expect(runScheduledGate([{ ...packageFor(75), coverLetter: 'letter' }], ctx,
      { kind: question.kind, jobIds: question.jobIds, choiceId: 'skip' })).rejects.toMatchObject({ name: 'AgentExecutionCancelledError' })

    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.createGateReviewReceipt).not.toHaveBeenCalled()
    expect(mocks.skipApplicationForGate).not.toHaveBeenCalled()
  })

  it('restores an exact prior receipt before quality review and emits no duplicate package events', async () => {
    const ctx = context()
    const ownerFence = { owner: { userId: 'user_1', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', rootAttemptCount: 2,
      turnLeaseOwnerId: 'lease_1', turnLeaseVersion: 1, executionId: 'execution_1', executionAttemptCount: 4 },
      key: 'stable-gate-key', claimToken: 'claim_1', assertCurrent: vi.fn(async () => true) }
    Object.assign(ctx, { sessionId: 'session_1', turnId: 'turn_1', executionAttempt: { id: 'execution_1', attemptCount: 4 }, scheduledTaskGraphOwnerFence: ownerFence })
    mocks.findGateReviewReceiptReplay.mockResolvedValue({ id: 'prior_approval' })

    const result = await runScheduledGate([{ ...packageFor(75), coverLetter: 'Private letter body' }], ctx)

    expect(result).toMatchObject({ status: 'completed', pendingJobIds: ['job_1'], counts: { pending: 1 } })
    expect(mocks.findGateReviewReceiptReplay).toHaveBeenCalledOnce()
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.createGateReviewReceipt).not.toHaveBeenCalled()
    expect(ctx.emit).not.toHaveBeenCalledWith('agent_action', expect.anything())
    expect(ctx.emit).not.toHaveBeenCalledWith('artifact_reviewed', expect.anything())
    expect(ctx.emit).not.toHaveBeenCalledWith('application_review_ready', expect.anything())
  })

  it('does not emit free-text quality fit-gap or recommendations', async () => {
    const ctx = context()
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ clScore: 4, fitGap: 'PRIVATE_FIT_GAP', recommendation: 'PRIVATE_RECOMMENDATION', readyToApply: false }) })

    const result = await runScheduledGate([{ ...packageFor(75), coverLetter: 'Private letter body' }], ctx)

    expect(result).toMatchObject({ status: 'question_required', kind: 'weak_cover_letter', jobIds: ['job_1'] })
    expect(JSON.stringify(vi.mocked(ctx.emit).mock.calls)).not.toContain('PRIVATE_FIT_GAP')
    expect(JSON.stringify(vi.mocked(ctx.emit).mock.calls)).not.toContain('PRIVATE_RECOMMENDATION')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  })

  it('restores an earlier receipt before applying the next question in a multi-package Gate', async () => {
    const ownerFence = { owner: { userId: 'user_1', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', rootAttemptCount: 2,
      turnLeaseOwnerId: 'lease_1', turnLeaseVersion: 1, executionId: 'execution_1', executionAttemptCount: 4 },
      key: 'stable-gate-key', claimToken: 'claim_1', assertCurrent: vi.fn(async () => true) }
    const choice1 = createScheduledTaskGraphGateQuestion('weak_cover_letter', ['job_1'])!
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ clScore: 4, fitGap: 'private gap', recommendation: 'private text', readyToApply: false }) })
    const firstCtx = context()
    Object.assign(firstCtx, { sessionId: 'session_1', turnId: 'turn_1', executionAttempt: { id: 'execution_1', attemptCount: 4 }, scheduledTaskGraphOwnerFence: ownerFence })

    const first = await runScheduledGate([
      { ...packageFor(75, undefined, 'job_1'), coverLetter: 'letter 1' },
      { ...packageFor(75, undefined, 'job_2'), coverLetter: 'letter 2' },
    ], firstCtx, { kind: choice1.kind, jobIds: choice1.jobIds, choiceId: 'review' })

    expect(first).toMatchObject({ status: 'question_required', kind: 'weak_cover_letter', jobIds: ['job_2'] })
    expect(mocks.createGateReviewReceipt).toHaveBeenCalledTimes(1)
    expect(mocks.createGateReviewReceipt.mock.calls[0]?.[1].job.id).toBe('job_1')

    mocks.createGateReviewReceipt.mockClear()
    mocks.findGateReviewReceiptReplay.mockImplementation(async (_ctx, pkg) => pkg.job.id === 'job_1' ? { id: 'prior_job_1_receipt' } : null)
    const choice2 = createScheduledTaskGraphGateQuestion('weak_cover_letter', ['job_2'])!
    const secondCtx = context()
    Object.assign(secondCtx, { sessionId: 'session_1', turnId: 'turn_1', executionAttempt: { id: 'execution_1', attemptCount: 4 }, scheduledTaskGraphOwnerFence: ownerFence })

    const second = await runScheduledGate([
      { ...packageFor(75, undefined, 'job_1'), coverLetter: 'letter 1' },
      { ...packageFor(75, undefined, 'job_2'), coverLetter: 'letter 2' },
    ], secondCtx, { kind: choice2.kind, jobIds: choice2.jobIds, choiceId: 'skip' })

    expect(second).toMatchObject({ status: 'completed', pendingJobIds: ['job_1'], skippedJobIds: ['job_2'] })
    expect(mocks.modelChat).toHaveBeenCalledTimes(3)
    expect(mocks.findGateReviewReceiptReplay).toHaveBeenCalledTimes(4)
    expect(mocks.createGateReviewReceipt).not.toHaveBeenCalled()
    expect(secondCtx.emit).not.toHaveBeenCalledWith('agent_action', { role: 'reviewer', action: expect.stringContaining('job_1') })
  })

  it('restores a prior skip while applying the current answer for the next weak-letter question', async () => {
    const ownerFence = { owner: { userId: 'user_1', sessionId: 'session_1', turnId: 'turn_1', rootTaskId: 'root_1', rootAttemptCount: 2,
      turnLeaseOwnerId: 'lease_1', turnLeaseVersion: 1, executionId: 'execution_1', executionAttemptCount: 4 },
      key: 'stable-gate-key', claimToken: 'claim_1', assertCurrent: vi.fn(async () => true) }
    const scheduledContext = () => {
      const ctx = context()
      Object.assign(ctx, { sessionId: 'session_1', turnId: 'turn_1', executionAttempt: { id: 'execution_1', attemptCount: 4 }, scheduledTaskGraphOwnerFence: ownerFence })
      return ctx
    }
    const packages = [
      { ...packageFor(75, undefined, 'job_1'), coverLetter: 'letter 1' },
      { ...packageFor(75, undefined, 'job_2'), coverLetter: 'letter 2' },
    ]
    const firstCtx = scheduledContext()
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ clScore: 4, fitGap: 'gap', recommendation: 'improve', readyToApply: false }) })
    const first = await runScheduledGate(packages, firstCtx)
    expect(first).toMatchObject({ status: 'question_required', kind: 'weak_cover_letter', jobIds: ['job_1'] })

    const skipFirst = { kind: 'weak_cover_letter', jobIds: ['job_1'], choiceId: 'skip' }
    const secondCtx = scheduledContext()
    const second = await runScheduledGate(packages, secondCtx, skipFirst)
    expect(second).toMatchObject({ status: 'question_required', kind: 'weak_cover_letter', jobIds: ['job_2'] })
    expect(mocks.skipApplicationForGate).toHaveBeenCalledOnce()

    const thirdCtx = scheduledContext()
    mocks.modelChat.mockClear()
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ clScore: 9, fitGap: '', recommendation: 'ready', readyToApply: true }) })
    const reviewSecond = { kind: 'weak_cover_letter', jobIds: ['job_2'], choiceId: 'review' }
    const third = await runScheduledGate(packages, thirdCtx, reviewSecond, [skipFirst])

    expect(third).toMatchObject({ status: 'completed', pendingJobIds: ['job_2'], skippedJobIds: ['job_1'], counts: { pending: 1, skipped: 1 } })
    expect(mocks.modelChat).toHaveBeenCalledOnce()
    expect(mocks.findGateReviewReceiptReplay.mock.calls.slice(-2).map(call => call[1].job.id)).toEqual(['job_1', 'job_2'])
    expect(mocks.skipApplicationForGate).toHaveBeenCalledTimes(2)
    expect(mocks.createGateReviewReceipt).toHaveBeenCalledTimes(1)
    expect(mocks.createGateReviewReceipt.mock.calls[0]?.[1].job.id).toBe('job_2')
    expect(thirdCtx.emit).not.toHaveBeenCalledWith('agent_action', { role: 'reviewer', action: expect.stringContaining('job_1') })
  })

  it('keeps an unavailable quality review on the normal pending fallback path', async () => {
    const ctx = context()
    mocks.modelChat.mockRejectedValue(new Error('provider-secret-detail'))

    const result = await runScheduledGate([{ ...packageFor(75), coverLetter: 'Private letter body',
      job: { ...packageFor(75).job, description: 'Private job description' } }], ctx)

    expect(result).toMatchObject({ status: 'completed', nextStage: 'execute', pendingJobIds: ['job_1'], counts: { pending: 1 } })
    expect(ctx.emit).not.toHaveBeenCalledWith('agent_question', expect.anything())
  })
})
