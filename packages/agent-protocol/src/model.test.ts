import { describe, expect, it } from 'vitest'
import { validate } from './validation.js'
import { ModelRequestSchema, ModelResponseSchema } from './model.js'

const request = {
  schemaVersion: 'agent-harness.v2',
  provider: 'openai-compatible',
  model: 'applymate-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Find jobs' }] }],
  tools: [],
  capabilities: { nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false },
}

describe('provider-neutral model protocol', () => {
  it('accepts a model request and a tool-call response', () => {
    expect(validate(ModelRequestSchema, request)).toBe(true)
    expect(validate(ModelResponseSchema, {
      schemaVersion: 'agent-harness.v2', provider: request.provider, model: request.model,
      finishReason: 'tool_calls', toolCalls: [{ id: 'call-1', name: 'jobs.search', arguments: { query: 'backend' } }],
      usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 }, continuationCursor: null,
    })).toBe(true)
  })

  it('rejects empty model messages and unsupported finish reasons', () => {
    expect(validate(ModelRequestSchema, { ...request, messages: [] })).toBe(false)
    expect(validate(ModelResponseSchema, {
      schemaVersion: 'agent-harness.v2', provider: request.provider, model: request.model,
      finishReason: 'unknown', toolCalls: [], usage: null, continuationCursor: null,
    })).toBe(false)
  })
})
