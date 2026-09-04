import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), summary: vi.fn() }))

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { rolloutStage: { findUnique: mocks.findUnique } } }))
vi.mock('@/lib/rollout/diff-store', () => ({ summarizeRolloutDiffs: mocks.summary }))

describe('GET /api/rollout/status', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAdmin.mockReset().mockResolvedValue({ userId: 'admin-1', roleKey: 'platform_admin', requestId: 'request-3' })
    mocks.findUnique.mockReset().mockResolvedValue({ environment: 'staging', stageKey: '1%', rolloutPercent: 1, enabled: true, internalUserIds: ['opaque-user'], observationStartedAt: new Date('2026-01-01T00:00:00.000Z'), observationEndsAt: new Date('2026-01-01T04:00:00.000Z'), version: 2, status: 'active', rollbackReason: null, lastTransitionAt: new Date('2026-01-01T00:00:00.000Z') })
    mocks.summary.mockReset().mockResolvedValue({ total: 5, withinThreshold: 5, byMetric: {} })
  })

  it('returns stage, thresholds, deterministic allocation policy, and aggregate diff status', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/rollout/status?environment=staging') as never)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ environment: 'staging', persisted: true, current: { stage: '1%', rolloutPercent: 1, internalUserCount: 1 }, diffStorageAvailable: true, diffSummary: { total: 5 }, allocation: { decisionPoint: 'session.start' } })
    expect(body.current).not.toHaveProperty('internalUserIds')
    expect(body).toHaveProperty('thresholds.turnCompletionRate.minimum', 0.99)
  })

  it('keeps the status API available and reports missing diff storage during migration rollout', async () => {
    mocks.summary.mockRejectedValue(new Error('missing table'))
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/rollout/status') as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ diffStorageAvailable: false, diffSummary: null })
  })
})
