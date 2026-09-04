import { describe, expect, it } from 'vitest'
import { AGENT_HARNESS_PROTOCOL_VERSION, AgentSessionSchema, AgentTurnSchema, schemaVersion, validate } from './index.js'

describe('public protocol export surface', () => {
  it('exposes schema and derived runtime validation from the package root', () => {
    expect(AGENT_HARNESS_PROTOCOL_VERSION).toBe('agent-harness.v2')
    expect(schemaVersion).toBe('agent-harness.v2')
    expect(validate(AgentSessionSchema, {})).toBe(false)
    expect(AgentTurnSchema.$id).toBe('agent.turn')
  })
})
