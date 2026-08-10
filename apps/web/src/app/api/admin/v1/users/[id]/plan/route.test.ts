import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  validateWrite: vi.fn(),
  userFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  planChangeCreate: vi.fn(),
  userUpdate: vi.fn(),
  subscriptionUpdateMany: vi.fn(),
  subscriptionCreate: vi.fn(),
  transactionSubscriptionFindUnique: vi.fn(),
  runMutation: vi.fn(),
}))

vi.mock('@/lib/admin/authorization', () => ({
  requireAdmin: mocks.requireAdmin,
  isAdminResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validateWrite }))
vi.mock('@/lib/admin/dto', () => ({ adminUserMetadataSelect: { id: true }, toAdminUserMetadata: (value: unknown) => value }))
vi.mock('@/lib/admin/user-lifecycle', () => ({
  parsePlan: (value: unknown) => value === 'free' || value === 'pro' || value === 'enterprise' ? value : null,
  reasonFrom: (value: unknown) => typeof value === 'string' && value.trim().length >= 10 ? value.trim() : { error: 'reason is required' },
}))
vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mocks.userFindUnique },
    userPlanSubscription: { findUnique: mocks.subscriptionFindUnique },
    userPlanChange: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/admin/write-transaction', () => ({
  runAdminMutation: mocks.runMutation,
  AdminMutationConflict: class AdminMutationConflict extends Error {},
}))

const params = Promise.resolve({ id: 'user_1' })

describe('/api/admin/v1/users/:id/plan', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'super_admin', requestId: 'request_1' })
    mocks.validateWrite.mockReturnValue(null)
    mocks.userFindUnique.mockResolvedValue({ plan: 'free' })
    mocks.subscriptionFindUnique.mockResolvedValue({ id: 'subscription_1', plan: 'free', status: 'active', trialStartsAt: null, trialEndsAt: null, currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'), currentPeriodEnd: null, cancelAtPeriodEnd: false, version: 3, updatedAt: new Date('2026-08-01T00:00:00.000Z') })
    mocks.userUpdate.mockResolvedValue({ id: 'user_1', plan: 'pro' })
    mocks.subscriptionUpdateMany.mockResolvedValue({ count: 1 })
    mocks.subscriptionCreate.mockResolvedValue({ id: 'subscription_1', plan: 'pro', status: 'trialing', version: 1 })
    mocks.transactionSubscriptionFindUnique.mockResolvedValue({ id: 'subscription_1', plan: 'pro', status: 'trialing', version: 4 })
    mocks.runMutation.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown> }) => ({
      duplicate: false,
      value: await input.mutate({ user: { update: mocks.userUpdate }, userPlanChange: { create: mocks.planChangeCreate }, userPlanSubscription: { updateMany: mocks.subscriptionUpdateMany, create: mocks.subscriptionCreate, findUniqueOrThrow: mocks.transactionSubscriptionFindUnique } }),
    }))
  })

  it('lets a core administrator change the plan and subscription settings atomically', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'plan-key-1' },
      body: JSON.stringify({ toPlan: 'pro', status: 'trialing', trialEndsAt: '2026-09-01T00:00:00.000Z', currentPeriodEnd: '2026-09-30T00:00:00.000Z', cancelAtPeriodEnd: false, version: 3, reason: 'Granting a reviewed Pro trial to this candidate' }),
    }) as never, { params })

    expect(response.status).toBe(200)
    expect(mocks.requireAdmin).toHaveBeenCalledWith('billing.update', expect.any(Request))
    expect(mocks.planChangeCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ fromPlan: 'free', toPlan: 'pro', actorUserId: 'admin_1' }) }))
    expect(mocks.subscriptionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user_1', version: 3 }, data: expect.objectContaining({ plan: 'pro', status: 'trialing', version: { increment: 1 } }) }))
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ subscription: expect.objectContaining({ plan: 'pro', status: 'trialing' }) }))
  })

  it('rejects a stale subscription version before mutating the user', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'plan-key-stale' },
      body: JSON.stringify({ toPlan: 'pro', status: 'active', version: 2, reason: 'Changing a stale subscription must be rejected' }),
    }) as never, { params })

    expect(response.status).toBe(409)
    expect(mocks.runMutation).not.toHaveBeenCalled()
  })

  it('rejects a subscription changed during the transaction', async () => {
    mocks.subscriptionUpdateMany.mockResolvedValue({ count: 0 })
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'plan-key-race' },
      body: JSON.stringify({ toPlan: 'pro', status: 'active', version: 3, reason: 'Rejecting a concurrent package update safely' }),
    }) as never, { params })

    expect(response.status).toBe(409)
    expect(mocks.userUpdate).toHaveBeenCalled()
    expect(mocks.transactionSubscriptionFindUnique).not.toHaveBeenCalled()
  })

  it('denies a caller without billing.update before reading the target user', async () => {
    mocks.requireAdmin.mockResolvedValue(Response.json({ error: 'Forbidden' }, { status: 403 }))
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', { method: 'PATCH', headers: { Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'plan-key-denied' }, body: '{}' }) as never, { params })

    expect(response.status).toBe(403)
    expect(mocks.userFindUnique).not.toHaveBeenCalled()
  })
})
