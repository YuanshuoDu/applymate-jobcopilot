import { beforeEach, describe, expect, it, vi } from 'vitest'

const create = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db', () => ({ db: { aiUsageEvent: { create } } }))
import { aiUsageErrorCode, recordAiUsage } from './ai-usage'

describe('recordAiUsage', () => {
  beforeEach(() => create.mockReset().mockResolvedValue({ id: 'usage-1' }))

  it('records token, cost, feature, and credential ownership metadata', async () => {
    await recordAiUsage({ userId: 'user-1', featureKey: 'scoring', provider: 'openai', model: 'gpt-5.6-terra', inputTokens: 25.9, outputTokens: 10, estimatedCostUsd: 0.004, latencyMs: 42, status: 'success', credentialSource: 'user' })
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'user-1', featureKey: 'scoring', inputTokens: 25, outputTokens: 10, estimatedCostUsd: 0.004, credentialSource: 'user' }) })
  })

  it('stores a stable error class instead of a provider response body', async () => {
    const upstream = new Error('OpenAI API error 429: {"error":"secret upstream response"}')
    await recordAiUsage({ provider: 'openai', model: 'gpt-5.6-terra', latencyMs: 42, status: 'error', errorCode: upstream.message })
    expect(aiUsageErrorCode(upstream)).toBe('http_429')
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ errorCode: 'http_429' }) })
    expect(JSON.stringify(create.mock.calls)).not.toContain('secret upstream response')
  })
})
