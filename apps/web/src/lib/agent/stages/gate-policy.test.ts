import { describe, expect, it, vi } from 'vitest'
import { AgentExecutionCancelledError } from '../execution-control'
import type { ApplicationPackage, PipelineCtx } from '../types'
import { runGatePolicy } from './gate-policy'

const mocks = vi.hoisted(() => ({ skipApplicationForGate: vi.fn(), findGateReviewReceiptReplay: vi.fn() }))
vi.mock('../application-control', () => ({ skipApplicationForGate: mocks.skipApplicationForGate }))
vi.mock('./gate-review-receipt', () => ({ createGateReviewReceipt: vi.fn(), findGateReviewReceiptReplay: mocks.findGateReviewReceiptReplay }))

describe('runGatePolicy extraction', () => {
  it('preserves the empty-package completion path', async () => {
    const ctx = { agentCfg: { minMatchScore: 70 }, emit: vi.fn() } as unknown as PipelineCtx

    await expect(runGatePolicy([], ctx, false)).resolves.toMatchObject({
      status: 'stage_completed', result: { stage: 'gate', data: { approved: [], pending: [], skipped: [] } },
    })
  })

  it('checks the scheduled owner before applying Gate policy', async () => {
    const ctx = { agentCfg: { minMatchScore: 70 }, emit: vi.fn(), scheduledTaskGraphOwnerFence: {},
      assertExecutionCurrent: vi.fn().mockResolvedValue(false) } as unknown as PipelineCtx

    await expect(runGatePolicy([], ctx, true)).rejects.toBeInstanceOf(AgentExecutionCancelledError)
    expect(ctx.assertExecutionCurrent).toHaveBeenCalledOnce()
  })

  it('passes Gate source hooks into the scheduled skip transaction', async () => {
    mocks.findGateReviewReceiptReplay.mockResolvedValue(null)
    const sourceHooks = { acquireFence: vi.fn(), validateSource: vi.fn() }
    const ctx = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', executionAttempt: { id: 'execution-1', attemptCount: 2 },
      agentCfg: { minMatchScore: 70 }, emit: vi.fn(), assertExecutionCurrent: vi.fn().mockResolvedValue(true),
      scheduledTaskGraphOwnerFence: { owner: {} as never, key: 'claim', claimToken: 'token', gateTaskId: 'gate-task', assertCurrent: vi.fn(), sourceHooks } } as unknown as PipelineCtx
    const pkg = { job: { id: 'job-1' }, score: 30, matchedKeywords: [], missingKeywords: [], recommendation: '' } as unknown as ApplicationPackage

    await runGatePolicy([pkg], ctx, true)

    expect(mocks.skipApplicationForGate).toHaveBeenCalledWith(expect.objectContaining({ owner: expect.objectContaining({ sourceHooks }) }))
  })
})
