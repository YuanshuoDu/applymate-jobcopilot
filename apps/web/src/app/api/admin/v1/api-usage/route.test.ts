import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), queryRaw: vi.fn(), quotaFindMany: vi.fn(), jobAggregate: vi.fn(), aiAggregate: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof NextResponse }))
vi.mock('@/lib/db', () => ({ db: { $queryRaw: mocks.queryRaw, apiQuota: { findMany: mocks.quotaFindMany }, jobApiUsageEvent: { aggregate: mocks.jobAggregate }, aiUsageEvent: { aggregate: mocks.aiAggregate } } }))
import { GET } from './route'

function capturedSql(call: readonly unknown[]) {
  const [template, ...values] = call
  if (!Array.isArray(template) || !('raw' in template)) throw new Error('Expected a Prisma tagged query')
  const query = Prisma.sql(template as TemplateStringsArray, ...(values as never[]))
  return { text: query.text, values: query.values }
}

describe('GET /api/admin/v1/api-usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', permissions: ['observability.read'], roleKey: 'ops', requestId: 'req-1' })
    mocks.queryRaw.mockResolvedValueOnce([{ provider: 'cleanjobdata', operation: 'list', credentialSource: 'platform', calls: 4, jobs: 40, errors: 1, avgLatency: 120, lastEventAt: new Date('2026-08-23T10:00:00Z') }]).mockResolvedValueOnce([{ provider: 'minimax', model: 'MiniMax-M3', credentialSource: 'platform', calls: 2, inputTokens: 100, outputTokens: 20, cost: 0.001, errors: 0, avgLatency: 80, lastEventAt: new Date('2026-08-23T11:00:00Z') }]).mockResolvedValueOnce([{ provider: 'resend', operation: 'contact_email', credentialSource: 'platform', calls: 3, inputBytes: 30, outputBytes: 60, cost: 0, errors: 1, avgLatency: 90, lastEventAt: new Date('2026-08-23T09:00:00Z') }]).mockResolvedValueOnce([])
    mocks.quotaFindMany.mockResolvedValue([])
    mocks.aiAggregate.mockResolvedValue({ _sum: { inputTokens: 111, outputTokens: 22, estimatedCostUsd: 0.75 }, _count: 3 })
  })

  it('returns unified job and model summaries without exposing credentials', async () => {
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/api-usage?days=7'))
    const payload = await response.json()
    expect(payload.days).toBe(7)
    expect(payload.job.summary).toMatchObject({ calls: 4, jobs: 40, errors: 1 })
    expect(payload.ai.summary).toMatchObject({ calls: 2, tokens: 120 })
    expect(payload.external.summary).toMatchObject({ calls: 3, dataBytes: 90, costKnown: false, errors: 1 })
    expect(payload.external.providers.find((row: { key: string }) => row.key === 'upstash-redis')).toMatchObject({ calls: 0, source: 'unavailable' })
    expect(payload.external.providers.find((row: { key: string }) => row.key === 'neon-postgres')).toMatchObject({ calls: 0, source: 'unavailable', period: null })
    expect(payload.external.providers.find((row: { key: string }) => row.key === 'azure-key-vault')).toMatchObject({ calls: 0, source: 'unavailable', period: null })
    expect(payload.external.summary.currency).toBeNull()
    expect(payload.external.providers.find((row: { key: string }) => row.key === 'resend')).toMatchObject({ costKnown: false })
    expect(payload.job.providers.find((row: { key: string }) => row.key === 'fantasticjobs')).toMatchObject({ calls: 0, jobs: 0 })
    expect(payload.job.providers.find((row: { key: string }) => row.key === 'cleanjobdata').lastEventAt).toBe('2026-08-23T10:00:00.000Z')
    expect(payload.freshness.lastEventAt).toBe('2026-08-23T11:00:00.000Z')
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

  it('excludes pending AI reservations from completed summaries and quota totals', async () => {
    mocks.queryRaw.mockReset()
    mocks.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ provider: 'minimax', model: 'MiniMax-M3', credentialSource: 'platform', calls: 2, inputTokens: 50, outputTokens: 15, cost: 0.03, errors: 1, avgLatency: 80, lastEventAt: new Date('2026-11-12T11:00:00Z') }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ day: new Date('2026-11-12T00:00:00Z'), category: 'ai', calls: 2, errors: 1, units: 65, cost: 0.03 }])
      .mockResolvedValueOnce([{ userId: 'user-1', category: 'ai', calls: 2, jobs: 0, tokens: 65, bytes: 0, cost: 0.03, errors: 1, avgLatency: 80, lastEventAt: new Date('2026-11-12T11:00:00Z') }])
      .mockResolvedValueOnce([{ userId: 'user-1', category: 'ai', provider: 'minimax', operationModel: 'MiniMax-M3', featureKey: 'agent', runtime: 'worker', credentialSource: 'platform', calls: 2, jobs: 0, tokens: 65, bytes: 0, cost: 0.03, errors: 1, avgLatency: 80, lastEventAt: new Date('2026-11-12T11:00:00Z') }])
      .mockResolvedValueOnce([])
    mocks.quotaFindMany.mockResolvedValue([{ id: 'out', category: 'ai', provider: 'minimax', operation: '*', metric: 'output_tokens', planName: 'Platform', period: 'month', limit: 1000, resetDay: 1 }])
    mocks.aiAggregate.mockResolvedValue({ _sum: { inputTokens: 50, outputTokens: 15, estimatedCostUsd: 0.03 }, _count: 2 })

    const response = await GET(new NextRequest('http://localhost/api/admin/v1/api-usage?days=7&provider=minimax&userId=user-1'))
    const payload = await response.json()

    expect(payload.ai.summary).toMatchObject({ calls: 2, tokens: 65, costUsd: 0.03, errors: 1 })
    expect(payload.trend).toContainEqual(expect.objectContaining({ category: 'ai', calls: 2, units: 65, cost: 0.03 }))
    expect(payload.users).toContainEqual(expect.objectContaining({ userId: 'user-1', category: 'ai', calls: 2, tokens: 65 }))
    expect(payload.userDetails).toContainEqual(expect.objectContaining({ userId: 'user-1', provider: 'minimax', calls: 2, tokens: 65 }))
    expect(payload.quotas).toContainEqual(expect.objectContaining({ metric: 'output_tokens', used: 15 }))

    const statements = mocks.queryRaw.mock.calls.map(capturedSql)
    const aiStatements = statements.filter(statement => statement.text.includes('ai_usage_events'))
    expect(aiStatements).toHaveLength(4)
    for (const statement of aiStatements) {
      expect(statement.text).toContain("status IN ('success', 'error')")
      expect(statement.text).toMatch(/created_at >= \$\d+/)
      expect(statement.values.some(value => value instanceof Date)).toBe(true)
      expect(statement.values).toContain('minimax')
    }
    const userDetail = aiStatements.find(statement => statement.text.includes('WHERE user_id ='))
    expect(userDetail?.text).toMatch(/user_id = \$\d+/)
    expect(userDetail?.values).toContain('user-1')
    expect(mocks.aiAggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ provider: 'minimax', credentialSource: 'platform', status: { in: ['success', 'error'] }, createdAt: expect.objectContaining({ gte: expect.any(Date), lt: expect.any(Date) }) }),
    }))
  })

  it('rejects malformed provider filters before querying usage', async () => {
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/api-usage?provider=bad%20provider'))
    expect(response.status).toBe(400)
    expect(mocks.queryRaw).not.toHaveBeenCalled()
  })

  it('filters the external provider catalogue', async () => {
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/api-usage?provider=resend'))
    const payload = await response.json()
    expect(payload.external.providers.map((row: { key: string }) => row.key)).toEqual(['resend'])
  })

  it('returns user-attributed summaries and drill-down rows', async () => {
    mocks.queryRaw.mockReset()
    mocks.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { userId: 'user-1', category: 'job', calls: 2, jobs: 18, tokens: 0, bytes: 0, cost: 0, errors: 0, avgLatency: 100, lastEventAt: new Date('2026-08-23T12:00:00Z') },
        { userId: 'user-1', category: 'external', calls: 1, jobs: 0, tokens: 0, bytes: 128, cost: 0, errors: 0, avgLatency: 40, lastEventAt: new Date('2026-08-23T12:01:00Z') },
      ])
      .mockResolvedValueOnce([
        { userId: 'user-1', category: 'job', provider: 'cleanjobdata', operationModel: 'list', featureKey: null, runtime: 'worker', credentialSource: 'platform', calls: 2, jobs: 18, tokens: 0, bytes: 0, cost: 0, errors: 0, avgLatency: 100, lastEventAt: new Date('2026-08-23T12:00:00Z') },
        { userId: 'user-1', category: 'external', provider: 'internal-worker', operationModel: 'agent_run', featureKey: null, runtime: 'unknown', credentialSource: 'platform', calls: 1, jobs: 0, tokens: 0, bytes: 128, cost: 0, errors: 0, avgLatency: 40, lastEventAt: new Date('2026-08-23T12:01:00Z') },
      ])
    mocks.quotaFindMany.mockResolvedValue([])

    const response = await GET(new NextRequest('http://localhost/api/admin/v1/api-usage?userId=user-1'))
    const payload = await response.json()
    expect(payload.selectedUserId).toBe('user-1')
    expect(payload.users).toEqual(expect.arrayContaining([expect.objectContaining({ userId: 'user-1', category: 'job', calls: 2, jobs: 18 })]))
    expect(payload.userDetails).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'cleanjobdata', runtime: 'worker', calls: 2 })]))
    expect(payload.users).toEqual(expect.arrayContaining([expect.objectContaining({ userId: 'user-1', category: 'external', calls: 1, bytes: 128 })]))
    expect(payload.userDetails).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'internal-worker', operationModel: 'agent_run', bytes: 128 })]))
  })
})
