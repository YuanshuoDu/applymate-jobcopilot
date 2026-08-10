import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validate: vi.fn(), mutation: vi.fn(), worker: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/worker-client', () => ({ sendWorkerCommand: mocks.worker }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))

describe('POST /api/admin/v1/queues/:queue/resume', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin', roleKey: 'operations', requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { queue: 'agent-runs' } })
    mocks.worker.mockResolvedValue({ receipt: 'receipt-1' })
    mocks.audit.mockResolvedValue(undefined)
  })

  it('delegates queue resume to the atomic admin mutation helper', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/queues/agent-runs/resume', { method: 'POST', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Resume agent workers after a controlled maintenance window' }) }) as never, { params: Promise.resolve({ queue: 'agent-runs' }) })
    expect(response.status).toBe(200)
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'queue.resume_requested', idempotencyKey: 'key', targetId: 'agent-runs' }))
  })

  it('dispatches the Worker command only after the audit transaction commits', async () => {
    let committed = false
    mocks.mutation.mockImplementation(async (input) => {
      const value = await input.mutate({})
      committed = true
      return { duplicate: false, value }
    })
    mocks.worker.mockImplementation(async () => {
      expect(committed).toBe(true)
      return { receipt: 'worker-receipt' }
    })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/admin/v1/queues/agent-runs/resume', { method: 'POST', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Resume agent workers after a controlled maintenance window' }) }) as never, { params: Promise.resolve({ queue: 'agent-runs' }) })

    await expect(response.json()).resolves.toEqual({ queue: 'agent-runs', receipt: 'worker-receipt' })
  })

  it('records a failed dispatch and does not claim that the queue changed', async () => {
    mocks.worker.mockRejectedValueOnce(new Error('worker unavailable'))
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/admin/v1/queues/agent-runs/resume', { method: 'POST', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Resume agent workers after a controlled maintenance window' }) }) as never, { params: Promise.resolve({ queue: 'agent-runs' }) })

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'Queue control plane unavailable' })
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'queue.resume_failed', outcome: 'failed' }))
  })
})
