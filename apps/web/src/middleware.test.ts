import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const mocks = vi.hoisted(() => ({ auth: vi.fn() }))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('@/lib/auth-secret', () => ({ getAuthJwtSecret: () => new TextEncoder().encode('test-secret') }))

import { middleware } from './middleware'

describe('web middleware entrypoint', () => {
  beforeEach(() => mocks.auth.mockReset())

  it('lives beside the src app directory so Next.js loads it', () => {
    expect(existsSync(fileURLToPath(new URL('./middleware.ts', import.meta.url)))).toBe(true)
  })

  it('applies admin security headers to admin API requests', async () => {
    const response = await middleware(new NextRequest('http://localhost/api/admin/v1/users'))

    expect(response.headers.get('Cache-Control')).toBe('no-store, private')
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('leaves non-admin API authentication to the route handler', async () => {
    const response = await middleware(new NextRequest('http://localhost/api/plans'))

    expect(response.status).toBe(200)
    expect(mocks.auth).not.toHaveBeenCalled()
  })

  it('applies admin security headers to an authenticated admin page', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'admin_1' } })

    const response = await middleware(new NextRequest('http://localhost/admin'))

    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  })
})
