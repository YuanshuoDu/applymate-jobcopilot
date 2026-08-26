import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), queryRaw: vi.fn(), quotaFindMany: vi.fn(), jobAggregate: vi.fn(), aiAggregate: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof NextResponse }))
vi.mock('@/lib/db', () => ({ db: { $queryRaw: mocks.queryRaw, apiQuota: { findMany: mocks.quotaFindMany }, jobApiUsageEvent: { aggregate: mocks.jobAggregate }, aiUsageEvent: { aggregate: mocks.aiAggregate } } }))
import { GET } from './route'

describe('GET /api/admin/v1/api-usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', permissions: ['observability.read'], roleKey: 'ops', requestId: 'req-1' })
    mocks.queryRaw.mockResolvedValueOnce([{ provider: 'cleanjobdata', operation: 'list', credentialSource: 'platform', calls: 4, jobs: 40, errors: 1, avgLatency: 120, lastEventAt: new Date('2026-08-23T10:00:00Z') }]).mockResolvedValueOnce([{ provider: 'minimax', model: 'MiniMax-M3', credentialSource: 'platform', calls: 2, inputTokens: 100, outputTokens: 20, cost: 0.001, errors: 0, avgLatency: 80, lastEventAt: new Date('2026-08-23T11:00:00Z') }]).mockResolvedValueOnce([]).mockResolvedValueOnce([
      { userId: 'user-1', category: 'job', calls: 4, jobs: 40, tokens: 0, cost: 0, errors: 1, avgLatency: 120, lastEventAt: new Date('2026-08-23T10:00:00Z') },
      { userId: 'user-1', category: 'ai', calls: 2, jobs: 0, tokens: 120, cost: 0.001, errors: 0, avgLatency: 80, lastEventAt: new Date('2026-08-23T11:00:00Z') },
    ])
    mocks.quotaFindMany.mockResolvedValue([])
    mocks.aiAggregate.mockResolvedValue({ _sum: { inputTokens: 111, outputTokens: 22, estimatedCostUsd: 0.75 }, _count: 3 })
  })

  it('returns unified job and model summaries without exposing credentials', async () => {
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/api-usage?days=7'))
    const payload = await response.json()
    expect(payload.days).toBe(7)
    expect(payload.job.summary).toMatchObject({ calls: 4, jobs: 40, errors: 1 })
    expect(payload.ai.summary).toMatchObject({ calls: 2, tokens: 120 })
    expect(payload.job.providers.find((row: { key: string }) => row.key === 'fantasticjobs')).toMatchObject({ calls: 0, jobs: 0 })
    expect(payload.job.providers.find((row: { key: string }) => row.key === 'cleanjobdata').lastEventAt).toBe('2026-08-23T10:00:00.000Z')
    expect(payload.freshness.lastEventAt).toBe('2026-08-23T11:00:00.000Z')
    expect(payload.users).toEqual(expect.arrayContaining([expect.objectContaining({ userId: 'user-1', category: 'job', calls: 4, jobs: 40 })]))
    expect(JSON.stringify(payload)).not.toContain('apiKey')
  })

  it('filters the provider catalogue and quota query', async () => {
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/api-usage?provider=cleanjobdata'))
    const payload = await response.json()
    expect(payload.provider).toBe('cleanjobdata')
    expect(payload.job.providers.map((row: { key: string }) => row.key)).toEqual(['cleanjobdata'])
    expect(mocks.quotaFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { enabled: true, provider: 'cleanjobdata' } }))
  })

  it('aggregates each formal AI quota metric independently', async () => {
    mocks.quotaFindMany.mockResolvedValue([
      { id: 'in', category: 'ai', provider: 'minimax', operation: '*', metric: 'input_tokens', planName: 'Platform', period: 'month', limit: 1000, resetDay: 1 },
      { id: 'out', category: 'ai', provider: 'minimax', operation: '*', metric: 'output_tokens', planName: 'Platform', period: 'month', limit: 1000, resetDay: 1 },
      { id: 'cost', category: 'ai', provider: 'minimax', operation: '*', metric: 'cost_usd', planName: 'Platform', period: 'month', limit: 10, resetDay: 1 },
    ])
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/api-usage'))
    const payload = await response.json()
    expect(Object.fromEntries(payload.quotas.map((quota: { metric: string; used: number }) => [quota.metric, quota.used]))).toEqual({ input_tokens: 111, output_tokens: 22, cost_usd: 0.75 })
  })

  it('rejects malformed provider filters before querying usage', async () => {
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/api-usage?provider=bad%20provider'))
    expect(response.status).toBe(400)
    expect(mocks.queryRaw).not.toHaveBeenCalled()
  })

  it('returns selected user details with the worker runtime dimension', async () => {
    mocks.queryRaw.mockReset()
    mocks.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ userId: 'user-1', category: 'ai', calls: 1, jobs: 0, tokens: 20, cost: 0.01, errors: 0, avgLatency: 40, lastEventAt: new Date() }])
      .mockResolvedValueOnce([{ userId: 'user-1', category: 'ai', provider: 'minimax', operationModel: 'MiniMax-M3', featureKey: 'autoApply', runtime: 'worker', credentialSource: 'platform', calls: 1, jobs: 0, tokens: 20, cost: 0.01, errors: 0, avgLatency: 40, lastEventAt: new Date() }])
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/api-usage?userId=user-1'))
    const payload = await response.json()
    expect(payload.selectedUserId).toBe('user-1')
    expect(payload.userDetails).toEqual([expect.objectContaining({ featureKey: 'autoApply', runtime: 'worker' })])
  })
})
