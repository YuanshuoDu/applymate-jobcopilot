import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validate: vi.fn(), findPolicy: vi.fn(), worker: vi.fn(), mutation: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/worker-client', () => ({ sendWorkerCommand: mocks.worker }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))
vi.mock('@/lib/db', () => ({ db: { atsSourcePolicy: { findUnique: mocks.findPolicy } } }))

describe('POST /api/admin/v1/ats/:sourceKey/pause', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'approver', roleKey: 'operations', requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.findPolicy.mockResolvedValue({ state: 'pending_pause', pauseRequestedById: 'requester' })
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { state: 'paused', version: 4, alreadyPaused: false, propagation: 'acknowledged' } })
  })
  it('allows a different authorized administrator to complete a pending pause', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/ats/lever/pause', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Pausing discovery while provider errors are investigated' }) }) as never, { params: Promise.resolve({ sourceKey: 'lever' }) })
    expect(response.status).toBe(200)
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'ats.pause', idempotencyKey: 'key', targetId: 'lever' }))
  })
})
