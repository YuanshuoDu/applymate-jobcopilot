import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope, AgentSession } from '@jobcopilot/agent-protocol'

const compileOnlyWebReference = (session: AgentSession, event: AgentEventEnvelope) => ({ session, event })

describe('agent protocol Web boundary', () => {
  it('resolves protocol types without importing provider or persistence code', () => {
    expect(typeof compileOnlyWebReference).toBe('function')
  })
})
