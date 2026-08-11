import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/lib/auth', () => ({ handlers: { GET: mocks.get, POST: mocks.post } }))

import { GET, POST } from './route'

describe('Auth.js route host boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.get.mockResolvedValue(new Response(null, { status: 204 }))
    mocks.post.mockResolvedValue(new Response(null, { status: 204 }))
  })

  it('does not expose provider enumeration or OAuth callbacks on the administrator host', async () => {
    const providers = await GET(new NextRequest('https://admin.applymate.site/api/auth/providers'))
    const callback = await GET(new NextRequest('https://admin.applymate.site/api/auth/callback/google'))

    expect(providers.status).toBe(404)
    expect(callback.status).toBe(404)
    expect(providers.headers.get('Cache-Control')).toBe('no-store, private')
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('permits credential callbacks required for administrator sessions', async () => {
    const response = await POST(new NextRequest('https://admin.applymate.site/api/auth/callback/credentials', { method: 'POST' }))

    expect(response.status).toBe(204)
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })

  it('keeps public-host provider discovery available to the ordinary login page', async () => {
    const response = await GET(new NextRequest('https://applymate.site/api/auth/providers'))

    expect(response.status).toBe(204)
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })
})
