import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), mutation: vi.fn(), worker: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/worker-client', () => ({ sendWorkerCommand: mocks.worker }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))

describe('POST /api/admin/v1/queues worker control', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin', roleKey: 'operations', requestId: 'request' })
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { action: 'pause' } })
    mocks.worker.mockResolvedValue({ receipt: 'receipt-1', worker: { status: 'paused', state: 'paused' } })
    mocks.audit.mockResolvedValue(undefined)
  })

  it('persists the admin intent before dispatching a global pause command', async () => {
    let committed = false
    mocks.mutation.mockImplementation(async (input) => {
      const value = await input.mutate({})
      committed = true
      return { duplicate: false, value }
    })
    mocks.worker.mockImplementation(async () => {
      expect(committed).toBe(true)
      return { receipt: 'worker-receipt', worker: { status: 'paused', state: 'paused' } }
    })

    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/queues', { method: 'POST', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ action: 'pause', reason: 'Pause all queues during a controlled maintenance window' }) }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ receipt: 'worker-receipt', worker: { status: 'paused', state: 'paused' } })
    expect(mocks.worker).toHaveBeenCalledWith(expect.objectContaining({ action: 'pause_worker', reason: 'Pause all queues during a controlled maintenance window' }))
  })

  it('rejects an invalid action before authorization', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/queues', { method: 'POST', body: JSON.stringify({ action: 'stop', reason: 'Invalid action should not dispatch' }) }) as never)

    expect(response.status).toBe(400)
    expect(mocks.requireAdmin).not.toHaveBeenCalled()
    expect(mocks.worker).not.toHaveBeenCalled()
  })

  it('returns 503 when the Worker control plane cannot be reached', async () => {
    mocks.worker.mockRejectedValueOnce(new Error('worker unavailable'))
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/queues', { method: 'POST', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ action: 'resume', reason: 'Resume all queues after the maintenance window' }) }) as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'Worker control plane unavailable' })
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'worker.resumed_failed', outcome: 'failed' }))
  })
})
