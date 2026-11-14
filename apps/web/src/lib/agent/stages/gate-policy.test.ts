import { describe, expect, it, vi } from 'vitest'
import { AgentExecutionCancelledError } from '../execution-control'
import type { PipelineCtx } from '../types'
import { runGatePolicy } from './gate-policy'

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
})
