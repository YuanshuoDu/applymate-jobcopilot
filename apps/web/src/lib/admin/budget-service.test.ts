import { beforeEach, describe, expect, it, vi } from 'vitest'

const findUnique = vi.fn()
const budgetCreate = vi.fn()
const updateMany = vi.fn()
const create = vi.fn()
const resetFindUnique = vi.fn()
const resetUpdateMany = vi.fn()
vi.mock('@/lib/db', () => ({ db: { $transaction: (callback: (tx: unknown) => unknown) => callback({ aiBudget: { findUnique, updateMany, create: budgetCreate }, aiBudgetAdjustment: { create }, aiBudgetResetRequest: { findUnique: resetFindUnique, updateMany: resetUpdateMany } }) } }))
import { approveBudgetReset, updateBudgetLimit } from './budget-service'

describe('budget overrides', () => {
  beforeEach(() => { vi.clearAllMocks() })
  it('writes an immutable adjustment only after the optimistic update succeeds', async () => {
    findUnique.mockResolvedValue({ id: 'budget', used: 4, limit: 10, version: 2 })
    updateMany.mockResolvedValue({ count: 1 })
    create.mockResolvedValue({ id: 'adjustment' })
    await expect(updateBudgetLimit({ userId: 'user', month: '2026-08', limit: 12, version: 2, actorUserId: 'admin', reason: 'Approved temporary monthly credit increase', idempotencyKey: 'key' })).resolves.toEqual({ used: 4, limit: 12, version: 3 })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ previousLimit: 10, nextLimit: 12 }) }))
  })

  it('resets usage only when a different approver accepts a current request', async () => {
    resetFindUnique.mockResolvedValue({ id: 'reset', requesterId: 'requester', status: 'pending', expiresAt: new Date(Date.now() + 60_000), budgetVersion: 3, budget: { id: 'budget', used: 8, limit: 10, version: 3 } })
    updateMany.mockResolvedValue({ count: 1 })
    resetUpdateMany.mockResolvedValue({ count: 1 })
    create.mockResolvedValue({ id: 'adjustment' })
    await expect(approveBudgetReset({ requestId: 'reset', approverId: 'approver', idempotencyKey: 'approval-key' })).resolves.toEqual({ budgetId: 'budget', version: 4, previousUsed: 8 })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'usage_reset', previousUsed: 8, nextUsed: 0 }) }))
  })

  it('initializes a missing monthly budget through the same audited update path', async () => {
    findUnique.mockResolvedValue(null)
    budgetCreate.mockResolvedValue({ id: 'created-budget' })
    create.mockResolvedValue({ id: 'adjustment' })
    await expect(updateBudgetLimit({ userId: 'user', month: '2026-08', limit: 12, version: 1, actorUserId: 'admin', reason: 'Set the initial monthly AI credit budget', idempotencyKey: 'initial-key', initialLimit: 25 })).resolves.toEqual({ used: 0, limit: 12, version: 2 })
    expect(budgetCreate).toHaveBeenCalledWith({ data: { userId: 'user', month: '2026-08', used: 0, limit: 12, version: 2 } })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ previousLimit: 25, nextLimit: 12 }) }))
  })
})
