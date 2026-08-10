import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendWorkerCommand } from './worker-client'

describe('worker client', () => {
  afterEach(() => { delete process.env.WORKER_CONTROL_URL; delete process.env.WORKER_CONTROL_SECRET; vi.unstubAllGlobals() })
  it('refuses to issue a command without separate worker credentials', async () => {
    await expect(sendWorkerCommand({ requestId: 'request', actorId: 'admin', action: 'queue_summary', reason: 'View queue health summary', params: {} })).rejects.toThrow('not configured')
  })
  it('signs an allow-listed command before sending it to the private control endpoint', async () => {
    process.env.WORKER_CONTROL_URL = 'https://worker.internal'
    process.env.WORKER_CONTROL_SECRET = 'test-secret'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ receipt: 'ok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendWorkerCommand({ requestId: 'request', actorId: 'admin', action: 'queue_summary', reason: 'View queue health summary', params: {} })).resolves.toEqual({ receipt: 'ok' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://worker.internal/internal/admin/control')
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toHaveProperty('x-worker-control-signature')
  })
})
