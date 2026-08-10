import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validate: vi.fn(), mutation: vi.fn(), propagate: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/worker-client', () => ({ sendWorkerCommand: vi.fn() }))
vi.mock('@/lib/admin/ats-policy-propagation', () => ({ acknowledgeCommittedAtsPolicy: mocks.propagate }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation, AdminMutationConflict: class AdminMutationConflict extends Error {} }))

describe('POST /api/admin/v1/ats/:sourceKey/resume', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin', roleKey: 'operations', requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { state: 'enabled', version: 5, propagation: 'pending' } })
    mocks.propagate.mockResolvedValue('acknowledged')
  })

  it('delegates ATS resume to the atomic admin mutation helper', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/ats/lever/resume', { method: 'POST', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ version: 4, reason: 'Resume discovery after provider health is restored' }) }) as never, { params: Promise.resolve({ sourceKey: 'lever' }) })
    expect(response.status).toBe(200)
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'ats.resumed', idempotencyKey: 'key', targetId: 'lever' }))
  })

  it('propagates a resumed source only after the transaction commits', async () => {
    let committed = false
    mocks.mutation.mockImplementation(async () => {
      committed = true
      return { duplicate: false, value: { state: 'enabled', version: 5, propagation: 'pending' } }
    })
    mocks.propagate.mockImplementation(async () => {
      expect(committed).toBe(true)
      return 'acknowledged'
    })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/ats/lever/resume', { method: 'POST', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ version: 4, reason: 'Resume discovery after provider health is restored' }) }) as never, { params: Promise.resolve({ sourceKey: 'lever' }) })

    await expect(response.json()).resolves.toEqual({ state: 'enabled', version: 5, propagation: 'acknowledged' })
    expect(mocks.propagate).toHaveBeenCalled()
  })
})
