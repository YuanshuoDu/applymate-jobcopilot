import { describe, expect, it } from 'vitest'
import { validate } from './validation.js'
import { AgentTurnSchema } from './turn.js'

const turn = {
  schemaVersion: 'agent-harness.v2',
  id: 'turn-1',
  sessionId: 'session-1',
  source: 'user',
  goal: 'Compare the best matches',
  status: 'in_progress',
  activeStepId: 'step-1',
  finalItemId: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
  completedAt: null,
}

describe('AgentTurn schema', () => {
  it('accepts an active turn with an active step', () => {
    expect(validate(AgentTurnSchema, turn)).toBe(true)
  })

  it('rejects terminal state with an invalid status value', () => {
    expect(validate(AgentTurnSchema, { ...turn, status: 'done' })).toBe(false)
  })
})
