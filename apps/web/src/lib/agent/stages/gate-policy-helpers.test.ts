import { describe, expect, it, vi } from 'vitest'
import { AgentExecutionCancelledError } from '../execution-control'
import type { ApplicationPackage, PipelineCtx } from '../types'
import { assertScheduledGateCurrent, gateWriteOwner, prepareReviewedPackage } from './gate-policy-helpers'

describe('Gate policy helpers', () => {
  it('creates a write owner only for a complete session execution', () => {
    expect(gateWriteOwner({} as PipelineCtx)).toBeUndefined()
    expect(() => gateWriteOwner({ sessionId: 'session-1' } as unknown as PipelineCtx)).toThrow(AgentExecutionCancelledError)
    expect(gateWriteOwner({ sessionId: 'session-1', turnId: 'turn-1', executionAttempt: 2 } as unknown as PipelineCtx))
      .toMatchObject({ turnId: 'turn-1', executionAttempt: 2 })
  })

  it('skips artifact work when no prepared artifacts exist', () => {
    const pkg = { job: { id: 'job-1' } } as ApplicationPackage
    const result = prepareReviewedPackage(pkg, {} as PipelineCtx)

    expect(result).toEqual({ reviewedPackage: pkg, artifacts: [], issues: [], reviews: [] })
  })

  it('enforces the scheduled owner fence when present', async () => {
    const assertExecutionCurrent = vi.fn().mockResolvedValue(false)
    const stale = { scheduledTaskGraphOwnerFence: {}, assertExecutionCurrent } as unknown as PipelineCtx

    await expect(assertScheduledGateCurrent(stale, true)).rejects.toBeInstanceOf(AgentExecutionCancelledError)
    expect(assertExecutionCurrent).toHaveBeenCalledOnce()
    await expect(assertScheduledGateCurrent(stale, false)).resolves.toBeUndefined()
  })
})
