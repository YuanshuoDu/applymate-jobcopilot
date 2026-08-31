import { describe, expect, it } from 'vitest'
import { validate } from './validation.js'
import { ToolCallSchema, ToolDefinitionSchema } from './tool.js'

const definition = {
  schemaVersion: 'agent-harness.v2',
  name: 'jobs.search',
  version: '1',
  description: 'Search jobs within the current user scope',
  capabilities: ['read'],
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
}

describe('tool protocol', () => {
  it('accepts a provider-neutral definition and call', () => {
    expect(validate(ToolDefinitionSchema, definition)).toBe(true)
    expect(validate(ToolCallSchema, {
      schemaVersion: 'agent-harness.v2',
      id: 'call-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolName: definition.name,
      toolVersion: definition.version,
      status: 'queued',
      input: { query: 'backend' },
      errorCode: null,
      createdAt: '2026-08-31T00:00:00.000Z',
      completedAt: null,
    })).toBe(true)
  })

  it('rejects an unregistered capability and invalid status', () => {
    expect(validate(ToolDefinitionSchema, { ...definition, capabilities: ['admin'] })).toBe(false)
    expect(validate(ToolCallSchema, {
      schemaVersion: 'agent-harness.v2', id: 'call-1', turnId: 'turn-1', stepId: 'step-1',
      toolName: 'jobs.search', toolVersion: '1', status: 'started', input: {}, errorCode: null,
      createdAt: '2026-08-31T00:00:00.000Z', completedAt: null,
    })).toBe(false)
  })
})
