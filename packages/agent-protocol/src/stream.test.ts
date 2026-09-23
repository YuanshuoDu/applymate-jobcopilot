import { describe, expect, it } from 'vitest'

import {
  AGENT_DELTA_STREAM_MAX_LENGTH,
  agentDeltaChannel,
  agentDeltaStream,
  agentEventChannel,
  createDeltaEnvelope,
  createDurableEnvelope,
} from './stream.js'

describe('agent stream contract', () => {
  it('uses session-scoped Redis keys', () => {
    expect(agentEventChannel('session_1')).toBe('agent:session:session_1:events')
    expect(agentDeltaStream('session_1')).toBe('agent:session:session_1:deltas')
    expect(agentDeltaChannel('session_1')).toBe('agent:session:session_1:delta-notify')
  })

  it('adds the protocol version without changing the stream payload', () => {
    const durable = createDurableEnvelope({
      id: 'event_1', sessionId: 'session_1', turnId: 'turn_1', itemId: null, taskId: null, type: 'item.completed',
      actor: 'orchestrator', correlationId: 'turn_1', causationId: null, idempotencyKey: null,
      sequence: '7', payload: { ok: true },
    })
    const delta = createDeltaEnvelope({
      ...durable, kind: 'snapshot', baseRevision: 2, revision: 3,
    })
    expect(durable).toMatchObject({ schemaVersion: 'agent-harness.v2', sequence: '7' })
    expect(delta).toMatchObject({ schemaVersion: 'agent-harness.v2', kind: 'snapshot', revision: 3 })
  })

  it('allows session lifecycle events without a turn', () => {
    const durable = createDurableEnvelope({
      id: 'event_paused', sessionId: 'session_1', turnId: null, itemId: null, taskId: null,
      type: 'session.paused', actor: 'system', correlationId: 'session_1', causationId: null,
      idempotencyKey: 'agent-session-control:client_1', sequence: '8',
      payload: {
        sessionId: 'session_1', operation: 'pause', previousGate: 'open', nextGate: 'user_paused',
        controlRevision: 1, pausedAt: '2026-09-15T00:00:00.000Z',
      },
    })
    expect(durable).toMatchObject({ type: 'session.paused', turnId: null, correlationId: 'session_1' })
  })

  it('keeps the transient stream bounded', () => {
    expect(AGENT_DELTA_STREAM_MAX_LENGTH).toBeGreaterThan(0)
  })
})
