import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validate: vi.fn(), findPolicy: vi.fn(), worker: vi.fn(), mutation: vi.fn(), propagate: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/worker-client', () => ({ sendWorkerCommand: mocks.worker }))
vi.mock('@/lib/admin/ats-policy-propagation', () => ({ acknowledgeCommittedAtsPolicy: mocks.propagate }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))
vi.mock('@/lib/db', () => ({ db: { atsSourcePolicy: { findUnique: mocks.findPolicy } } }))

describe('POST /api/admin/v1/ats/:sourceKey/pause', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'approver', roleKey: 'operations', requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.findPolicy.mockResolvedValue({ state: 'pending_pause', pauseRequestedById: 'requester' })
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { state: 'paused', version: 4, alreadyPaused: false, propagation: 'pending' } })
    mocks.propagate.mockResolvedValue('acknowledged')
  })
  it('allows a different authorized administrator to complete a pending pause', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/ats/lever/pause', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Pausing discovery while provider errors are investigated' }) }) as never, { params: Promise.resolve({ sourceKey: 'lever' }) })
    expect(response.status).toBe(200)
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'ats.pause', idempotencyKey: 'key', targetId: 'lever' }))
  })

  it('propagates an approved pause after the audit transaction commits', async () => {
    let committed = false
    mocks.mutation.mockImplementation(async () => {
      committed = true
      return { duplicate: false, value: { state: 'paused', version: 4, alreadyPaused: false, propagation: 'pending' } }
    })
    mocks.propagate.mockImplementation(async () => {
      expect(committed).toBe(true)
      return 'acknowledged'
    })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/ats/lever/pause', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Pausing discovery while provider errors are investigated' }) }) as never, { params: Promise.resolve({ sourceKey: 'lever' }) })

    await expect(response.json()).resolves.toEqual({ state: 'paused', version: 4, propagation: 'acknowledged' })
    expect(mocks.propagate).toHaveBeenCalled()
  })

  it('retries propagation for a paused policy until the Worker acknowledges its current version', async () => {
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { state: 'paused', version: 4, alreadyPaused: true } })
    mocks.propagate.mockResolvedValue('pending')
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/admin/v1/ats/lever/pause', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Retrying policy propagation after an unavailable Worker receipt' }) }) as never, { params: Promise.resolve({ sourceKey: 'lever' }) })

    await expect(response.json()).resolves.toEqual({ state: 'paused', version: 4, propagation: 'pending' })
    expect(mocks.propagate).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: 'lever', version: 4 }), expect.anything())
  })
})
