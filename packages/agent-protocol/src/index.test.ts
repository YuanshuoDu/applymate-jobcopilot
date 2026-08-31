import { describe, expect, it } from 'vitest'
import { AgentSessionSchema, AgentTurnSchema, schemaVersion, validate } from './index.js'

describe('public protocol export surface', () => {
  it('exposes schema and derived runtime validation from the package root', () => {
    expect(schemaVersion).toBe('agent-harness.v2')
    expect(validate(AgentSessionSchema, {})).toBe(false)
    expect(AgentTurnSchema.$id).toBe('agent.turn')
  })
})
