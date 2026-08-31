import { describe, expect, it } from 'vitest'
import { validate } from './validation.js'
import { AgentStepSchema } from './step.js'

const step = {
  schemaVersion: 'agent-harness.v2',
  id: 'step-1',
  turnId: 'turn-1',
  parentStepId: null,
  ordinal: 0,
  attempt: 1,
  status: 'streaming',
  inputSnapshotId: null,
  inputThroughSequence: 0,
  consumedInputIds: [],
  provider: 'custom',
  model: 'applymate-model',
  toolCallIds: [],
  finishReason: null,
  usage: null,
  errorCode: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
}

describe('AgentStep schema', () => {
  it('accepts the first model attempt', () => {
    expect(validate(AgentStepSchema, step)).toBe(true)
  })

  it('rejects zero attempts and negative token usage', () => {
    expect(validate(AgentStepSchema, { ...step, attempt: 0 })).toBe(false)
    expect(validate(AgentStepSchema, { ...step, usage: { inputTokens: -1, outputTokens: 0, estimatedCostUsd: 0 } })).toBe(false)
  })
})
