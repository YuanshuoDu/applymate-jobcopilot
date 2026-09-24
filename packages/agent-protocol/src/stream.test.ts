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

  it('keeps the transient stream bounded', () => {
    expect(AGENT_DELTA_STREAM_MAX_LENGTH).toBeGreaterThan(0)
  })
})
