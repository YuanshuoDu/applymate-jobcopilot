import { beforeEach, describe, expect, it, vi } from 'vitest'

const findUnique = vi.fn()
const updateMany = vi.fn()
const create = vi.fn()
vi.mock('@/lib/db', () => ({ db: { $transaction: (callback: (tx: unknown) => unknown) => callback({ aiBudget: { findUnique, updateMany }, aiBudgetAdjustment: { create } }) } }))
import { updateBudgetLimit } from './budget-service'

describe('budget overrides', () => {
  beforeEach(() => { vi.clearAllMocks() })
  it('writes an immutable adjustment only after the optimistic update succeeds', async () => {
    findUnique.mockResolvedValue({ id: 'budget', used: 4, limit: 10, version: 2 })
    updateMany.mockResolvedValue({ count: 1 })
    create.mockResolvedValue({ id: 'adjustment' })
    await expect(updateBudgetLimit({ userId: 'user', month: '2026-08', limit: 12, version: 2, actorUserId: 'admin', reason: 'Approved temporary monthly credit increase', idempotencyKey: 'key' })).resolves.toEqual({ used: 4, limit: 12, version: 3 })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ previousLimit: 10, nextLimit: 12 }) }))
  })
})
