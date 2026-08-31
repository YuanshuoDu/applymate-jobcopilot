import { describe, expect, it } from 'vitest'
import { validate } from './validation.js'
import { AgentItemSchema } from './item.js'

const base = {
  schemaVersion: 'agent-harness.v2',
  id: 'item-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  stepId: null,
  status: 'completed',
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
}

describe('AgentItem tagged union', () => {
  it('accepts commentary and final message phases', () => {
    expect(validate(AgentItemSchema, { ...base, type: 'agent_message', phase: 'commentary', text: 'Working' })).toBe(true)
    expect(validate(AgentItemSchema, { ...base, type: 'agent_message', phase: 'final_answer', text: 'Done' })).toBe(true)
  })

  it('accepts tool lifecycle items and rejects invalid phases', () => {
    expect(validate(AgentItemSchema, { ...base, type: 'tool_call', toolCallId: 'call-1', toolName: 'jobs.search', input: {} })).toBe(true)
    expect(validate(AgentItemSchema, { ...base, type: 'agent_message', phase: 'progress', text: 'Working' })).toBe(false)
  })
})
