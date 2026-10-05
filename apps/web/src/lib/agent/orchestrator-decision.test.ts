import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ modelChat: vi.fn() }))
vi.mock('@/lib/model-router', () => ({ modelChat: mocks.modelChat }))

describe('orchestrator decision helpers', () => {
  beforeEach(() => mocks.modelChat.mockReset())

  it('parses fenced JSON following model preamble text', async () => {
    const { parseDecision } = await import('./orchestrator-decision')
    expect(parseDecision('Here is the result:\n```json\n{"decision":"proceed","thinking":"Ready to continue."}\n```'))
      .toEqual({ decision: 'proceed', thinking: 'Ready to continue.' })
  })

  it.each([null, 42, '{ invalid', 'x'.repeat(16_001)])('rejects malformed or oversized decision text', async raw => {
    const { parseDecision } = await import('./orchestrator-decision')
    expect(parseDecision(raw)).toBeNull()
  })

  it('accepts only a bounded throttle adjustment on retryable stages', async () => {
    const { validateDecision, MAX_RETRY_THROTTLE_MS } = await import('./orchestrator-decision')
    const accepted = validateDecision({
      decision: 'retry', thinking: 'Slow the next attempt.', retry_fix: { throttleMs: MAX_RETRY_THROTTLE_MS },
    }, false, 'analyst', 300)
    expect(accepted?.retry_fix).toEqual({ throttleMs: MAX_RETRY_THROTTLE_MS })
    expect(validateDecision({
      decision: 'retry', thinking: 'Try again after audit.', retry_fix: { throttleMs: 500 },
    }, false, 'post-run', 300)).toBeNull()
  })

  it.each([
    { throttleMs: 299 },
    { throttleMs: 60_001 },
    { throttleMs: 300.5 },
    { throttleMs: '500' },
    { throttleMs: 500, requireApproval: false },
    { arbitrary: ['value'] },
  ])('rejects unsafe retry patch %j', async retryFix => {
    const { validateDecision } = await import('./orchestrator-decision')
    expect(validateDecision({ decision: 'retry', thinking: 'Try another pass.', retry_fix: retryFix }, false, 'scout', 300)).toBeNull()
  })

  it('retains bounded interactive options and action data', async () => {
    const { validateDecision } = await import('./orchestrator-decision')
    expect(validateDecision({
      decision: 'ask_user', thinking: 'A candidate choice is needed.', ask_question: 'Choose a resume.',
      ask_options: [{ label: 'Current', value: 'keep', action: { field: 'useTailoredCV', value: false } }],
    }, false, 'prepare', undefined)).toEqual({
      decision: 'ask_user', thinking: 'A candidate choice is needed.', ask_question: 'Choose a resume.',
      ask_options: [{ label: 'Current', value: 'keep', action: { field: 'useTailoredCV', value: false } }],
    })
  })

  it('builds the stage prompt and evaluates through ModelRouter', async () => {
    const { evaluateOrchestratorDecision } = await import('./orchestrator-decision')
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ decision: 'proceed', thinking: 'The stage can continue.' }) })
    const context = {
      agentCfg: { targetRoles: ['Engineer'], targetLocations: ['Berlin'], minMatchScore: 70, dailyLimit: 10, autoApply: false, throttleMs: 300 } as never,
      aiConfig: {} as never,
    }
    const decision = await evaluateOrchestratorDecision('scout', 'Found jobs', { jobCount: 2 }, context, false, ['old', 'recent'])
    expect(decision.decision).toBe('proceed')
    expect(mocks.modelChat).toHaveBeenCalledWith([
      { role: 'user', content: expect.stringContaining('Stage: scout') },
    ], context.aiConfig, 400)
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain('Recent history:\nold\nrecent')
  })
})
