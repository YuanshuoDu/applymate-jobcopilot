import { describe, expect, it } from 'vitest'
import type { AgentStep, ToolCall } from '@jobcopilot/agent-protocol'

const compileOnlyWorkerReference = (step: AgentStep, toolCall: ToolCall) => ({ step, toolCall })

describe('agent protocol Worker boundary', () => {
  it('resolves protocol types without importing Web or Prisma code', () => {
    expect(typeof compileOnlyWorkerReference).toBe('function')
  })
})
