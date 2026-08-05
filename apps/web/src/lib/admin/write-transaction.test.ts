import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))

describe('runAdminMutation', () => {
  it('runs idempotency claim, audit, and mutation in one transaction', async () => {
    const steps: string[] = []
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      adminIdempotencyKey: { create: vi.fn(async () => { steps.push('idempotency') }) },
      adminAuditLog: { create: vi.fn(async () => { steps.push('audit') }) },
    }))
    const { runAdminMutation } = await import('./write-transaction')
    const result = await runAdminMutation({
      actorUserId: 'admin-1', action: 'test.mutated', idempotencyKey: 'key-1',
      audit: { requestId: 'request-1', outcome: 'success' },
      mutate: async () => { steps.push('mutation'); return 'ok' },
    })
    expect(result).toEqual({ duplicate: false, value: 'ok' })
    expect(steps).toEqual(['idempotency', 'mutation', 'audit'])
  })
})
