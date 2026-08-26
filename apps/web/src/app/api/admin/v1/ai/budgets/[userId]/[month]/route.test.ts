import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validate: vi.fn(), budget: vi.fn(), user: vi.fn(), mutation: vi.fn(), resolveEntitlement: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation, AdminMutationConflict: class AdminMutationConflict extends Error {} }))
vi.mock('@/lib/db', () => ({ db: { aiBudget: { findUnique: mocks.budget }, user: { findUnique: mocks.user } } }))
vi.mock('@/lib/entitlements', () => ({ resolveEntitlement: mocks.resolveEntitlement }))

describe('PATCH /api/admin/v1/ai/budgets/:userId/:month', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin', roleKey: 'billing_admin', requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.budget.mockResolvedValue({ used: 4, version: 2 })
    mocks.user.mockResolvedValue({ id: 'user-1' })
    mocks.resolveEntitlement.mockResolvedValue({ kind: 'limit', enabled: true, limit: 25 })
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { used: 4, limit: 12, version: 3 } })
  })

  it('routes the budget update through the atomic admin mutation helper', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/ai/budgets/user-1/2026-08', { method: 'PATCH', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ limit: 12, version: 2, reason: 'Approved temporary monthly credit increase' }) }) as never, { params: Promise.resolve({ userId: 'user-1', month: '2026-08' }) })
    expect(response.status).toBe(200)
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_budget.limit_updated', idempotencyKey: 'key', targetId: 'user-1:2026-08' }))
  })

  it('returns duplicate without invoking a second business mutation', async () => {
    mocks.mutation.mockResolvedValue({ duplicate: true })
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/ai/budgets/user-1/2026-08', { method: 'PATCH', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ limit: 12, version: 2, reason: 'Approved temporary monthly credit increase' }) }) as never, { params: Promise.resolve({ userId: 'user-1', month: '2026-08' }) })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ duplicate: true })
  })

  it('initializes a budget when the user has not spent credits this month', async () => {
    mocks.budget.mockResolvedValue(null)
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/ai/budgets/user-1/2026-08', { method: 'PATCH', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ limit: 12, version: 1, reason: 'Set the initial monthly AI credit budget' }) }) as never, { params: Promise.resolve({ userId: 'user-1', month: '2026-08' }) })
    expect(response.status).toBe(200)
    expect(mocks.resolveEntitlement).toHaveBeenCalledWith('user-1', 'ai_credits')
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'user-1:2026-08' }))
  })
})
