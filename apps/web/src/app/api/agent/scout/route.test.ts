import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  connection: {
    get: vi.fn(),
    ttl: vi.fn(),
    set: vi.fn(),
    disconnect: vi.fn(),
  },
  queue: {
    add: vi.fn(),
    close: vi.fn(),
  },
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (value: unknown) => Response.json(value),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('ioredis', () => ({ Redis: vi.fn(() => mocks.connection) }))
vi.mock('bullmq', () => ({ Queue: vi.fn(() => mocks.queue) }))

import { POST } from './route'

describe('POST /api/agent/scout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.connection.get.mockResolvedValue(null)
    mocks.connection.set.mockResolvedValue('OK')
    mocks.queue.add.mockResolvedValue({ id: 'scout-job-1' })
  })

  it('does not enqueue Scout while the Worker automation is paused', async () => {
    mocks.connection.get.mockImplementation(async (key: string) => key === 'admin-control:worker-runtime-state'
      ? JSON.stringify({ status: 'paused' })
      : null)

    const response = await POST(new Request('http://localhost/api/agent/scout', { method: 'POST' }) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Automatic Scout is currently off. Search Jobs remains available.' })
    expect(mocks.queue.add).not.toHaveBeenCalled()
    expect(mocks.connection.set).not.toHaveBeenCalled()
  })

  it('enqueues Scout when the Worker automation is running', async () => {
    const response = await POST(new Request('http://localhost/api/agent/scout', { method: 'POST' }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ queued: true })
    expect(mocks.queue.add).toHaveBeenCalledWith('scout', { userId: 'user-1' }, expect.objectContaining({ jobId: 'scout:user-1' }))
    expect(mocks.connection.set).toHaveBeenCalledWith('scout:cooldown:user-1', expect.any(String), 'EX', 86_400)
  })
})
