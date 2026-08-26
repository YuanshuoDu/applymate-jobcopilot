import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  upsert: vi.fn(),
  getEffectiveEntitlements: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ db: { aiUsageEvent: { create: mocks.create }, aiBudget: { upsert: mocks.upsert } } }))
vi.mock('./entitlements', () => ({ getEffectiveEntitlements: mocks.getEffectiveEntitlements }))
import { aiUsageErrorCode, recordAiUsage } from './ai-usage'

describe('recordAiUsage', () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({ id: 'usage-1' })
    mocks.upsert.mockReset().mockResolvedValue({ id: 'budget-1' })
    mocks.getEffectiveEntitlements.mockReset().mockResolvedValue({ limits: { ai_credits: 30 } })
  })

  it('records token, cost, feature, and credential ownership metadata', async () => {
    await recordAiUsage({ userId: 'user-1', featureKey: 'scoring', provider: 'openai', model: 'gpt-5.6-terra', inputTokens: 25.9, outputTokens: 10, estimatedCostUsd: 0.004, latencyMs: 42, status: 'success', credentialSource: 'user' })
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'user-1', featureKey: 'scoring', inputTokens: 25, outputTokens: 10, estimatedCostUsd: 0.004, credentialSource: 'user' }) })
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { userId_month: { userId: 'user-1', month: expect.stringMatching(/^20\d{2}-\d{2}$/) } },
      create: { userId: 'user-1', month: expect.stringMatching(/^20\d{2}-\d{2}$/), used: 1, limit: 30 },
      update: { used: { increment: 1 } },
    })
  })

  it('stores a stable error class instead of a provider response body', async () => {
    const upstream = new Error('OpenAI API error 429: {"error":"secret upstream response"}')
    await recordAiUsage({ provider: 'openai', model: 'gpt-5.6-terra', latencyMs: 42, status: 'error', errorCode: upstream.message })
    expect(aiUsageErrorCode(upstream)).toBe('http_429')
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ errorCode: 'http_429' }) })
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain('secret upstream response')
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('counts a user-scoped provider error as one credit', async () => {
    await recordAiUsage({ userId: 'user-1', provider: 'minimax', model: 'MiniMax-M3', latencyMs: 42, status: 'error', errorCode: 'timeout' })
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { used: { increment: 1 } } }))
  })

  it('can record administrative provider tests without charging a user budget', async () => {
    await recordAiUsage({ userId: 'admin-1', provider: 'minimax', model: 'models-catalog', latencyMs: 42, status: 'success', chargeBudget: false })
    expect(mocks.create).toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
})
