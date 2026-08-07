import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validate: vi.fn(), existing: vi.fn(), budget: vi.fn(), mutation: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation, AdminMutationConflict: class AdminMutationConflict extends Error {} }))
vi.mock('@/lib/db', () => ({ db: { aiBudgetResetRequest: { findUnique: mocks.existing }, aiBudget: { findUnique: mocks.budget } } }))

describe('POST /api/admin/v1/ai/budgets/:userId/:month/reset', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin', roleKey: 'billing_admin', requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.existing.mockResolvedValue(null)
    mocks.budget.mockResolvedValue({ id: 'budget-1', version: 3 })
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { id: 'reset-1', status: 'pending', expiresAt: new Date('2026-08-06T00:30:00Z') } })
  })

  it('creates a reset request with idempotency and audit delegated to one transaction', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/ai/budgets/user-1/2026-08/reset', { method: 'POST', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Reset usage after a verified billing correction' }) }) as never, { params: Promise.resolve({ userId: 'user-1', month: '2026-08' }) })
    expect(response.status).toBe(201)
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_budget.reset_requested', idempotencyKey: 'key' }))
  })
})
