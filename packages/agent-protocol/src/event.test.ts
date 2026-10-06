import { describe, expect, it } from 'vitest'
import { AgentEventEnvelopeSchema, KnownAgentEventEnvelopeSchema, SessionControlEventPayloadSchema, isKnownAgentEventType } from './event.js'
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
    expect(isKnownAgentEventType('policy.decision')).toBe(true)
    expect(isKnownAgentEventType('approval.consumed')).toBe(true)
    expect(isKnownAgentEventType('external_action.reserved')).toBe(true)
    expect(isKnownAgentEventType('session.pause_requested')).toBe(true)
    expect(isKnownAgentEventType('session.resume_requested')).toBe(true)
    expect(isKnownAgentEventType('session.resumed')).toBe(true)
    expect(isKnownAgentEventType('session.paused')).toBe(true)
    expect(isKnownAgentEventType('session.pause_blocked')).toBe(true)
    expect(isKnownAgentEventType('future.event.v3')).toBe(false)
  })

  it('rejects invalid sequence and actor values', () => {
    expect(validate(AgentEventEnvelopeSchema, { ...base, type: 'item.started', sequence: -1 })).toBe(false)
    expect(validate(AgentEventEnvelopeSchema, { ...base, type: 'item.started', actor: 'operator' })).toBe(false)
  })

  it('validates bounded pause and resume request payloads', () => {
    const payload = { turnId: 'turn-1', expectedRevision: 3, requestedAt: '2026-10-06T00:00:00.000Z' }
    expect(validate(SessionControlEventPayloadSchema, payload)).toBe(true)
    expect(validate(SessionControlEventPayloadSchema, { ...payload, note: 'free-form' })).toBe(false)
    expect(validate(SessionControlEventPayloadSchema, { ...payload, expectedRevision: 2_147_483_648 })).toBe(false)
  })
})
