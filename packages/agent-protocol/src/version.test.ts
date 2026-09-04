import { describe, expect, it } from 'vitest'
import { AGENT_HARNESS_PROTOCOL_VERSION, protocolRevision, schemaVersion } from './version.js'

describe('protocol version', () => {
  it('publishes a stable schema namespace and revision', () => {
    expect(AGENT_HARNESS_PROTOCOL_VERSION).toBe('agent-harness.v2')
    expect(schemaVersion).toBe('agent-harness.v2')
    expect(protocolRevision).toBe(1)
  })
})
