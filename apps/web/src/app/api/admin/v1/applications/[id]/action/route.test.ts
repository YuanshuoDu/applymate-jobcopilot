import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validate: vi.fn(), run: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), eventCreate: vi.fn(), queue: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/write-transaction', async () => { const actual = await vi.importActual<typeof import('@/lib/admin/write-transaction')>('@/lib/admin/write-transaction'); return { ...actual, runAdminMutation: mocks.run } })
vi.mock('@/lib/auto-apply', () => ({ queueApplicationFill: mocks.queue }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { applicationTask: { findUnique: mocks.findUnique, updateMany: mocks.updateMany }, applicationTaskEvent: { create: mocks.eventCreate } } }))

describe('POST /api/admin/v1/applications/[id]/action', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks()
    mocks.validate.mockReturnValue(null)
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'req-1' })
    mocks.findUnique.mockResolvedValue({ id: 'task-1', userId: 'user-1', jobId: 'job-1', status: 'failed', checkpoint: 'form', job: { url: 'https://jobs.lever.co/acme/1' } })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.eventCreate.mockResolvedValue({})
    mocks.run.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown> }) => ({ duplicate: false, value: await input.mutate({ applicationTask: { updateMany: mocks.updateMany }, applicationTaskEvent: { create: mocks.eventCreate } }) }))
    mocks.queue.mockResolvedValue({ taskId: 'worker-1' })
    mocks.audit.mockResolvedValue(undefined)
  })

  it('retries using the durable task ID and queues only the non-submitting fill pass', async () => {
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/admin/v1/applications/task-1/action', { method: 'POST', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'retry-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retry', reason: 'Retry after reviewing the worker timeout' }) }), { params: Promise.resolve({ id: 'task-1' }) })
    expect(response.status).toBe(200)
    expect(mocks.queue).toHaveBeenCalledWith({ userId: 'user-1', jobId: 'job-1', applyUrl: 'https://jobs.lever.co/acme/1', applicationTaskId: 'task-1' })
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: 'task-1',
      status: 'failed',
      OR: [{ checkpoint: null }, { checkpoint: { notIn: ['submission_request_started', 'submission_uncertain'] } }],
    } }))
  })

  it('rejects unsupported actions before touching the task', async () => {
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/admin/v1/applications/task-1/action', { method: 'POST', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'bad-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', reason: 'This action is not supported here' }) }), { params: Promise.resolve({ id: 'task-1' }) })
    expect(response.status).toBe(400)
    expect(mocks.findUnique).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'manual_review'] as const)('conflicts when %s races with the submission-start checkpoint', async action => {
    mocks.findUnique.mockResolvedValueOnce({ id: 'task-1', userId: 'user-1', jobId: 'job-1', status: 'filling', checkpoint: 'browser_active', job: { url: 'https://jobs.lever.co/acme/1' } })
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/admin/v1/applications/task-1/action', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Idempotency-Key': `${action}-race`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason: 'Resolve the application after checking its current external state' }),
    }), { params: Promise.resolve({ id: 'task-1' }) })

    expect(response.status).toBe(409)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'task-1',
        status: 'filling',
        OR: [{ checkpoint: null }, { checkpoint: { notIn: ['submission_request_started', 'submission_uncertain'] } }],
      },
    }))
    expect(mocks.eventCreate).not.toHaveBeenCalled()
  })

  it.each(['submission_request_started', 'submission_uncertain'] as const)('rejects cancel and manual review when the initial read sees %s', async checkpoint => {
    mocks.findUnique.mockResolvedValue({ id: 'task-1', userId: 'user-1', jobId: 'job-1', status: 'filling', checkpoint, job: { url: 'https://jobs.lever.co/acme/1' } })
    const { POST } = await import('./route')
    for (const action of ['cancel', 'manual_review'] as const) {
      const response = await POST(new NextRequest('http://localhost/api/admin/v1/applications/task-1/action', {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Idempotency-Key': `${action}-${checkpoint}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason: 'Resolve the application after checking its current external state' }),
      }), { params: Promise.resolve({ id: 'task-1' }) })
      expect(response.status).toBe(409)
    }
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
  })

  it('does not mark a started task failed when an admin retry queue call errors', async () => {
    mocks.updateMany.mockReset().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    mocks.queue.mockRejectedValueOnce(new Error('queue response was lost'))
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('http://localhost/api/admin/v1/applications/task-1/action', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Idempotency-Key': 'retry-queue-race', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry', reason: 'Retry after reviewing the worker timeout' }),
    }), { params: Promise.resolve({ id: 'task-1' }) })

    expect(response.status).toBe(503)
    expect(mocks.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: {
      id: 'task-1',
      status: { in: ['filling', 'waiting_for_user'] },
      checkpoint: { in: ['materials_ready', 'form_fill_queued'] },
    } }))
    expect(mocks.eventCreate.mock.calls.map(([call]) => (call as { data: { type: string } }).data.type)).toEqual(['admin_retry_requested'])
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'application.retry_failed', outcome: 'failed' }))
  })
})
