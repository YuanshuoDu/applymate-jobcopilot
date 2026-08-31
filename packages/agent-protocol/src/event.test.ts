import { describe, expect, it } from 'vitest'
import { AgentEventEnvelopeSchema, KnownAgentEventEnvelopeSchema, isKnownAgentEventType } from './event.js'
import { validate } from './validation.js'

const base = {
  schemaVersion: 'agent-harness.v2',
  id: 'event-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  itemId: null,
  taskId: null,
  sequence: 0,
  actor: 'system',
  correlationId: 'correlation-1',
  causationId: null,
  idempotencyKey: null,
  payload: { version: 1 },
  createdAt: '2026-08-31T00:00:00.000Z',
}

describe('AgentEvent envelopes', () => {
  it('accepts known event types and preserves unknown envelopes', () => {
    expect(validate(KnownAgentEventEnvelopeSchema, { ...base, type: 'item.completed' })).toBe(true)
    const unknown = { ...base, type: 'future.event.v3', payload: ['opaque'] }
    expect(validate(AgentEventEnvelopeSchema, unknown)).toBe(true)
    expect(JSON.parse(JSON.stringify(unknown))).toEqual(unknown)
    expect(isKnownAgentEventType('item.completed')).toBe(true)
    expect(isKnownAgentEventType('future.event.v3')).toBe(false)
  })

  it('rejects invalid sequence and actor values', () => {
    expect(validate(AgentEventEnvelopeSchema, { ...base, type: 'item.started', sequence: -1 })).toBe(false)
    expect(validate(AgentEventEnvelopeSchema, { ...base, type: 'item.started', actor: 'operator' })).toBe(false)
  })
})
