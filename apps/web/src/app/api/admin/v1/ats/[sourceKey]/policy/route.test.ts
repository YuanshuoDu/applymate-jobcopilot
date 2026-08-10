import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validate: vi.fn(), mutation: vi.fn(), propagate: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/worker-client', () => ({ sendWorkerCommand: vi.fn() }))
vi.mock('@/lib/admin/ats-policy-propagation', () => ({ acknowledgeCommittedAtsPolicy: mocks.propagate }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation, AdminMutationConflict: class AdminMutationConflict extends Error {} }))

describe('PATCH /api/admin/v1/ats/:sourceKey/policy', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin', roleKey: 'platform_admin', requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { version: 2, propagation: 'pending' } })
    mocks.propagate.mockResolvedValue('acknowledged')
  })
  it('rejects a requested RPS value above the hard Workday ceiling', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/ats/workday/policy', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'key' }, body: JSON.stringify({ rolloutPercent: 100, globalRpsLimit: 2, perTenantRpsLimit: 1, maxRetries: 3, backoffBaseMs: 1000, allowAutoApply: false, version: 1, reason: 'Maintaining a compliant discovery pacing policy' }) }) as never, { params: Promise.resolve({ sourceKey: 'workday' }) })
    expect(response.status).toBe(400)
    expect(mocks.mutation).not.toHaveBeenCalled()
  })

  it('routes a valid policy update through the atomic admin mutation helper', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/ats/lever/policy', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'key' }, body: JSON.stringify({ rolloutPercent: 100, globalRpsLimit: 5, perTenantRpsLimit: 1, maxRetries: 3, backoffBaseMs: 1000, allowAutoApply: false, version: 1, reason: 'Maintaining a compliant discovery pacing policy' }) }) as never, { params: Promise.resolve({ sourceKey: 'lever' }) })
    expect(response.status).toBe(200)
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'ats.policy_updated', idempotencyKey: 'key', targetId: 'lever' }))
  })

  it('propagates only after the committed policy mutation returns', async () => {
    let committed = false
    mocks.mutation.mockImplementation(async () => {
      committed = true
      return { duplicate: false, value: { version: 2, propagation: 'pending' } }
    })
    mocks.propagate.mockImplementation(async () => {
      expect(committed).toBe(true)
      return 'acknowledged'
    })
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/ats/lever/policy', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'key' }, body: JSON.stringify({ rolloutPercent: 100, globalRpsLimit: 5, perTenantRpsLimit: 1, maxRetries: 3, backoffBaseMs: 1000, allowAutoApply: true, version: 1, reason: 'Maintaining a compliant discovery pacing policy' }) }) as never, { params: Promise.resolve({ sourceKey: 'lever' }) })

    await expect(response.json()).resolves.toEqual({ sourceKey: 'lever', version: 2, propagation: 'acknowledged' })
    expect(mocks.propagate).toHaveBeenCalled()
  })
})
