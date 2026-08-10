import { afterEach, describe, expect, it, vi } from 'vitest'

import { apiMutate } from './hooks'

describe('apiMutate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds a unique idempotency key to admin mutation requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await apiMutate('/api/admin/v1/plans', 'PATCH', { plans: [] })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })
})
