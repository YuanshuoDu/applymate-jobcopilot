import { describe, expect, it } from 'vitest'
import { AgentSessionControlCommandSchema } from './session-control.js'
import { validate } from './validation.js'

const command = {
  schemaVersion: 'agent-harness.v2', clientMessageId: 'command-1', sessionId: 'session-1', action: 'pause',
  expectedTurnId: 'turn-1', expectedRevision: 4,
}

describe('Agent session control command schema', () => {
  it('accepts a versioned turn-fenced pause or resume command', () => {
    expect(validate(AgentSessionControlCommandSchema, command)).toBe(true)
    expect(validate(AgentSessionControlCommandSchema, { ...command, action: 'resume' })).toBe(true)
  })

  it('requires a current Turn revision and rejects unknown fields or unbounded revisions', () => {
    expect(validate(AgentSessionControlCommandSchema, { ...command, expectedRevision: -1 })).toBe(false)
    expect(validate(AgentSessionControlCommandSchema, { ...command, expectedRevision: 2_147_483_648 })).toBe(false)
    expect(validate(AgentSessionControlCommandSchema, { ...command, expectedTurnId: null })).toBe(false)
    expect(validate(AgentSessionControlCommandSchema, { ...command, userId: 'other' })).toBe(false)
  })

  it('keeps authenticated owner scope outside the public request envelope', () => {
    expect(validate(AgentSessionControlCommandSchema, command)).toBe(true)
    expect(validate(AgentSessionControlCommandSchema, { ...command, userId: 'authenticated-user' })).toBe(false)
  })
})
