import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validate: vi.fn(), mutation: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/worker-client', () => ({ sendWorkerCommand: vi.fn() }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))

describe('POST /api/admin/v1/queues/:queue/resume', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin', roleKey: 'operations', requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { receipt: 'receipt-1' } })
  })

  it('delegates queue resume to the atomic admin mutation helper', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/queues/agent-runs/resume', { method: 'POST', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Resume agent workers after a controlled maintenance window' }) }) as never, { params: Promise.resolve({ queue: 'agent-runs' }) })
    expect(response.status).toBe(200)
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'queue.resumed', idempotencyKey: 'key', targetId: 'agent-runs' }))
  })
})
