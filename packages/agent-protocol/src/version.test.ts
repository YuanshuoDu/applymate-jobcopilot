import { describe, expect, it } from 'vitest'
import { protocolRevision, schemaVersion } from './version.js'

describe('protocol version', () => {
  it('publishes a stable schema namespace and revision', () => {
    expect(schemaVersion).toBe('agent-harness.v2')
    expect(protocolRevision).toBe(1)
  })
})
