import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), mutation: vi.fn() }))

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))
vi.mock('@/lib/db', () => ({ db: { rolloutStage: { findUnique: mocks.findUnique } } }))

const currentStage = {
  environment: 'staging', stageKey: '5%', rolloutPercent: 5, enabled: true, internalUserIds: [],
  observationStartedAt: new Date('2026-01-01T00:00:00.000Z'), observationEndsAt: new Date('2026-01-01T04:00:00.000Z'),
  version: 3, status: 'active', rollbackReason: null, lastTransitionAt: new Date('2026-01-01T00:00:00.000Z'),
}

describe('POST /api/rollout/rollback', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAdmin.mockReset().mockResolvedValue({ userId: 'admin-2', roleKey: 'super_admin', requestId: 'request-2' })
    mocks.findUnique.mockReset().mockResolvedValue(currentStage)
    mocks.mutation.mockReset().mockResolvedValue({ duplicate: false, value: { count: 1 } })
  })

  it('rolls back exactly one stage with admin approval and optimistic versioning', async () => {
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/rollout/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'rollback-key-1' }, body: JSON.stringify({ reason: 'Stop the canary after an operator review', expectedVersion: 3 }) })
    const response = await POST(request as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ previousStage: '5%', stage: '1%', automaticRollback: false })
    expect(mocks.requireAdmin).toHaveBeenCalledWith('feature_flags.approve', expect.anything())
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'rollout.stage_rollback' }))
  })

  it('does not perform an automatic rollback when every threshold passes', async () => {
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/rollout/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'rollback-key-2' }, body: JSON.stringify({ automatic: true, reason: 'Evaluate the canary metrics before rollback', metrics: { turnCompletionRate: 1, unauthorizedExternalAction: 0, submissionDuplicate: 0, replayConsistency: 1, costP95Ratio: 1 } }) })
    const response = await POST(request as never)
    expect(response.status).toBe(409)
    expect(mocks.mutation).not.toHaveBeenCalled()
  })
})
