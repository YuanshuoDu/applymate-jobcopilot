import { describe, expect, it } from 'vitest'
import { validate } from './validation.js'
import { AgentSessionSchema } from './session.js'

const session = {
  schemaVersion: 'agent-harness.v2',
  id: 'session-1',
  userId: 'user-1',
  goal: 'Find backend roles in Dublin',
  status: 'idle',
  source: 'chat',
  activeRootTurnId: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
}

describe('AgentSession schema', () => {
  it('accepts a canonical idle session', () => {
    expect(validate(AgentSessionSchema, session)).toBe(true)
  })

  it('rejects an unknown status and extra fields', () => {
    expect(validate(AgentSessionSchema, { ...session, status: 'working' })).toBe(false)
    expect(validate(AgentSessionSchema, { ...session, unexpected: true })).toBe(false)
  })

  it('accepts pending pause and resume transition statuses', () => {
    expect(validate(AgentSessionSchema, { ...session, status: 'pausing' })).toBe(true)
    expect(validate(AgentSessionSchema, { ...session, status: 'resuming' })).toBe(true)
  })
})
