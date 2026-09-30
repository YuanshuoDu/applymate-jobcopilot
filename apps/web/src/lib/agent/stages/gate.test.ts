import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationPackage, PipelineCtx } from '../types'

const mocks = vi.hoisted(() => ({ createGateReviewReceipt: vi.fn(), skipApplicationForGate: vi.fn(), modelChat: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/model-router', () => ({ modelChat: mocks.modelChat }))
vi.mock('../application-control', () => ({ skipApplicationForGate: mocks.skipApplicationForGate }))
vi.mock('./gate-review-receipt', () => ({ createGateReviewReceipt: mocks.createGateReviewReceipt }))

import { runGate } from './gate'

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

function packageFor(score: number, tailoredResumeId?: string): ApplicationPackage {
  return {
    job: { id: 'job_1', company: 'Example', role: 'Cyber Security Analyst', description: null } as ApplicationPackage['job'],
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
  mocks.skipApplicationForGate.mockReset()
  mocks.skipApplicationForGate.mockResolvedValue(true)
  mocks.modelChat.mockReset()
})

describe('runGate', () => {
  it('keeps a threshold-matching tailored resume in review even when autopilot is configured', async () => {
    const result = await runGate([packageFor(75, 'tailored_1')], context())
    expect(result.data?.approved).toHaveLength(0)
    expect(result.data?.pending).toHaveLength(1)
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
