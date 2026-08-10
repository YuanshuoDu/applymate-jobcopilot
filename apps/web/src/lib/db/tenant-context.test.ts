import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), executeRaw: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))

describe('withTenantContext', () => {
  it('sets a transaction-local tenant before running the query callback', async () => {
    const tx = { $executeRaw: mocks.executeRaw }
    mocks.transaction.mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
    const callback = vi.fn().mockResolvedValue('safe')
    const { withTenantContext } = await import('./tenant-context')
    await expect(withTenantContext('user_123', callback)).resolves.toBe('safe')
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(tx)
  })

  it('rejects malformed tenant identifiers before opening a transaction', async () => {
    mocks.transaction.mockReset()
    const { withTenantContext } = await import('./tenant-context')
    expect(() => withTenantContext('user;drop', vi.fn())).toThrow('Invalid tenant user id')
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
