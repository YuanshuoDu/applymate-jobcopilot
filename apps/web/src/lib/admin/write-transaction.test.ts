import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), idempotency: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))

describe('runAdminMutation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({ adminIdempotencyKey: { create: mocks.idempotency }, adminAuditLog: { create: mocks.audit } }))
    mocks.idempotency.mockResolvedValue(undefined)
    mocks.audit.mockResolvedValue(undefined)
  })

  it('runs idempotency claim, audit, and mutation in one transaction', async () => {
    const steps: string[] = []
    mocks.idempotency.mockImplementation(async () => { steps.push('idempotency') })
    mocks.audit.mockImplementation(async () => { steps.push('audit') })
    const { runAdminMutation } = await import('./write-transaction')
    const result = await runAdminMutation({
      actorUserId: 'admin-1', action: 'test.mutated', idempotencyKey: 'key-1',
      audit: { requestId: 'request-1', outcome: 'success' },
      mutate: async () => { steps.push('mutation'); return 'ok' },
    })
    expect(result).toEqual({ duplicate: false, value: 'ok' })
    expect(steps).toEqual(['idempotency', 'mutation', 'audit'])
  })

  it('returns duplicate without running business mutation or audit', async () => {
    mocks.idempotency.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }))
    const mutate = vi.fn()
    const { runAdminMutation } = await import('./write-transaction')
    await expect(runAdminMutation({ actorUserId: 'admin-1', action: 'test.mutated', idempotencyKey: 'key-1', audit: { requestId: 'request-1', outcome: 'success' }, mutate })).resolves.toEqual({ duplicate: true })
    expect(mutate).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('propagates mutation failure so the transaction can roll back', async () => {
    let rolledBack = false
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      try { return await callback({ adminIdempotencyKey: { create: mocks.idempotency }, adminAuditLog: { create: mocks.audit } }) } catch (error) { rolledBack = true; throw error }
    })
    const { runAdminMutation } = await import('./write-transaction')
    await expect(runAdminMutation({ actorUserId: 'admin-1', action: 'test.mutated', idempotencyKey: 'key-1', audit: { requestId: 'request-1', outcome: 'success' }, mutate: async () => { throw new Error('business failure') } })).rejects.toThrow('business failure')
    expect(rolledBack).toBe(true)
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('propagates audit failure so the business mutation is not committed', async () => {
    let rolledBack = false
    mocks.audit.mockRejectedValue(new Error('audit failure'))
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      try { return await callback({ adminIdempotencyKey: { create: mocks.idempotency }, adminAuditLog: { create: mocks.audit } }) } catch (error) { rolledBack = true; throw error }
    })
    const { runAdminMutation } = await import('./write-transaction')
    await expect(runAdminMutation({ actorUserId: 'admin-1', action: 'test.mutated', idempotencyKey: 'key-1', audit: { requestId: 'request-1', outcome: 'success' }, mutate: async () => 'ok' })).rejects.toThrow('audit failure')
    expect(rolledBack).toBe(true)
  })
})
