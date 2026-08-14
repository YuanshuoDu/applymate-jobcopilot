import { afterEach, describe, expect, it, vi } from 'vitest'

import { apiMutate, fetchWithTimeout } from './hooks'

describe('apiMutate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('adds a unique idempotency key to admin mutation requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'https://admin.applymate.site' } })

    await apiMutate('/api/admin/v1/plans', 'PATCH', { plans: [] })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.Origin).toBe('https://admin.applymate.site')
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('turns a slow request into a visible timeout error', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const request = fetchWithTimeout('/api/admin/v1/applications', {}, 1_000)
    const rejection = expect(request).rejects.toThrow('Request timed out after 1 seconds')
    await vi.advanceTimersByTimeAsync(1_000)

    await rejection
  })
})
