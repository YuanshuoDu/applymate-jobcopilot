import { describe, expect, it } from 'vitest'
import { validate } from './validation.js'
import { AgentInputCommandSchema, AgentInputSchema } from './input.js'

const command = {
  schemaVersion: 'agent-harness.v2',
  clientMessageId: 'client-message-1',
  sessionId: 'session-1',
  expectedTurnId: null,
  delivery: 'follow_up',
  content: [{ type: 'text', text: 'Find more roles' }],
}

describe('AgentInput schemas', () => {
  it('accepts text and attachment-free follow-up commands', () => {
    expect(validate(AgentInputCommandSchema, command)).toBe(true)
  })

  it('rejects empty content and unknown delivery modes', () => {
    expect(validate(AgentInputCommandSchema, { ...command, content: [] })).toBe(false)
    expect(validate(AgentInputCommandSchema, { ...command, delivery: 'append' })).toBe(false)
  })

  it('accepts an accepted input record with a consumed timestamp', () => {
    expect(validate(AgentInputSchema, {
      schemaVersion: command.schemaVersion,
      clientMessageId: command.clientMessageId,
      sessionId: command.sessionId,
      id: 'input-1',
      turnId: 'turn-1',
      delivery: command.delivery,
      state: 'consumed',
      content: command.content,
      createdAt: '2026-08-31T00:00:00.000Z',
      consumedAt: '2026-08-31T00:00:01.000Z',
    })).toBe(true)
  })
})
