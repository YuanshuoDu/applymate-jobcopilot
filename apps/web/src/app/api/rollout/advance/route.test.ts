import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), mutation: vi.fn() }))

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))
vi.mock('@/lib/db', () => ({ db: { rolloutStage: { findUnique: mocks.findUnique } } }))

const currentStage = {
  environment: 'staging', stageKey: 'internal-only', rolloutPercent: 0, enabled: true, internalUserIds: [],
  observationStartedAt: new Date('2026-01-01T00:00:00.000Z'), observationEndsAt: new Date('2026-01-02T00:00:00.000Z'),
  version: 1, status: 'active', rollbackReason: null, lastTransitionAt: new Date('2026-01-01T00:00:00.000Z'),
}

const passingMetrics = { turnCompletionRate: 1, unauthorizedExternalAction: 0, submissionDuplicate: 0, replayConsistency: 1, costP95Ratio: 1 }

describe('POST /api/rollout/advance', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAdmin.mockReset().mockResolvedValue({ userId: 'admin-1', roleKey: 'platform_admin', requestId: 'request-1' })
    mocks.findUnique.mockReset().mockResolvedValue(currentStage)
    mocks.mutation.mockReset().mockResolvedValue({ duplicate: false, value: { count: 1 } })
  })

  it('requires metrics before advancing and applies the optimistic version', async () => {
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/rollout/advance', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'advance-key-1' }, body: JSON.stringify({ stage: '1%', reason: 'Advance after the internal observation window', expectedVersion: 1, metrics: passingMetrics }) })
    const response = await POST(request as never)
    expect(response.status).toBe(200)
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'rollout.stage_advanced', targetId: 'staging' }))
  })

  it('automatically rolls back when an unsafe metric breaches its threshold', async () => {
    mocks.findUnique.mockResolvedValue({ ...currentStage, stageKey: '5%', rolloutPercent: 5 })
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/rollout/advance', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'advance-key-2' }, body: JSON.stringify({ stage: '25%', reason: 'Advance after the internal observation window', metrics: { ...passingMetrics, unauthorizedExternalAction: 1 } }) })
    const response = await POST(request as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ automaticRollback: true, previousStage: '5%', stage: '1%' })
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'rollout.auto_rollback' }))
  })

  it('does not write while the observation window is open', async () => {
    // Keep the fixture relative to the test clock so this regression test does not
    // silently expire when the calendar moves past the hard-coded date.
    mocks.findUnique.mockResolvedValue({ ...currentStage, observationStartedAt: new Date(Date.now() + 60_000), stageKey: 'internal-only' })
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/rollout/advance', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'advance-key-3' }, body: JSON.stringify({ stage: '1%', reason: 'Advance after the internal observation window', metrics: passingMetrics }) })
    const response = await POST(request as never)
    expect(response.status).toBe(409)
    expect(mocks.mutation).not.toHaveBeenCalled()
  })
})
