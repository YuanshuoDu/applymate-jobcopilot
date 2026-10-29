import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  upsert: vi.fn(),
  getEffectiveEntitlements: vi.fn(),
  tenantRlsEnabled: vi.fn(),
  currentTenantUserId: vi.fn(),
  runWithTenantContext: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ db: { aiUsageEvent: { create: mocks.create }, aiBudget: { upsert: mocks.upsert } } }))
vi.mock('./db/tenant-store', () => ({ tenantRlsEnabled: mocks.tenantRlsEnabled, currentTenantUserId: mocks.currentTenantUserId, runWithTenantContext: mocks.runWithTenantContext }))
vi.mock('./entitlements', () => ({ getEffectiveEntitlements: mocks.getEffectiveEntitlements }))
import { aiUsageErrorCode, recordAiUsage } from './ai-usage'

describe('recordAiUsage', () => {
  beforeEach(() => {
    mocks.tenantRlsEnabled.mockReset().mockReturnValue(false)
    mocks.currentTenantUserId.mockReset().mockReturnValue(null)
    mocks.runWithTenantContext.mockReset().mockImplementation((_id: string, callback: () => unknown) => callback())
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

  it('establishes tenant scope around both usage and budget writes when RLS is active', async () => {
    mocks.tenantRlsEnabled.mockReturnValue(true)
    let scoped = false
    mocks.runWithTenantContext.mockImplementation(async (id: string, callback: () => Promise<void>) => {
      expect(id).toBe('user-1')
      scoped = true
      try { await callback() } finally { scoped = false }
    })
    mocks.create.mockImplementation(async () => { expect(scoped).toBe(true) })
    mocks.upsert.mockImplementation(async () => { expect(scoped).toBe(true) })
    await recordAiUsage({ userId: 'user-1', provider: 'minimax', model: 'm', latencyMs: 1, status: 'success' })
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.upsert).toHaveBeenCalledOnce()
  })

  it('still charges one credit when the scoped usage insert fails', async () => {
    mocks.tenantRlsEnabled.mockReturnValue(true)
    mocks.create.mockRejectedValue(new Error('write unavailable'))
    await recordAiUsage({ userId: 'user-1', provider: 'minimax', model: 'm', latencyMs: 1, status: 'error' })
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.upsert).toHaveBeenCalledOnce()
  })

  it('does not charge for a scoped attempt when chargeBudget is false', async () => {
    mocks.tenantRlsEnabled.mockReturnValue(true)
    await recordAiUsage({ userId: 'user-1', provider: 'minimax', model: 'm', latencyMs: 1, status: 'error', chargeBudget: false })
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('does not replace an existing different tenant or charge its budget', async () => {
    mocks.tenantRlsEnabled.mockReturnValue(true)
    mocks.currentTenantUserId.mockReturnValue('other-user')
    await recordAiUsage({ userId: 'user-1', provider: 'minimax', model: 'm', latencyMs: 1, status: 'success' })
    expect(mocks.runWithTenantContext).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('preserves fail-open behavior if request scope cannot be established', async () => {
    mocks.tenantRlsEnabled.mockReturnValue(true)
    mocks.runWithTenantContext.mockImplementation(() => { throw new Error('scope unavailable') })
    await expect(recordAiUsage({ userId: 'user-1', provider: 'minimax', model: 'm', latencyMs: 1, status: 'success' })).resolves.toBeUndefined()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
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
