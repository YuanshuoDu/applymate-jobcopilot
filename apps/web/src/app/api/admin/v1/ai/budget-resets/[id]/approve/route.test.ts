import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validate: vi.fn(), duplicate: vi.fn(), request: vi.fn(), mutation: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation, AdminMutationConflict: class AdminMutationConflict extends Error {} }))
vi.mock('@/lib/db', () => ({ db: { aiBudgetResetRequest: { findUnique: mocks.duplicate } } }))

describe('POST /api/admin/v1/ai/budget-resets/:id/approve', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'approver', roleKey: 'billing_admin', requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.duplicate.mockResolvedValueOnce(null).mockResolvedValueOnce({ requesterId: 'requester', budget: { userId: 'user-1', month: '2026-08' } })
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { budgetId: 'budget-1', version: 4, previousUsed: 8 } })
  })

  it('routes reset approval through the atomic admin mutation helper', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/ai/budget-resets/reset-1/approve', { method: 'POST', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Approve reset after confirming the customer request' }) }) as never, { params: Promise.resolve({ id: 'reset-1' }) })
    expect(response.status).toBe(200)
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_budget.reset_approved', idempotencyKey: 'key', targetId: 'reset-1' }))
  })
})
