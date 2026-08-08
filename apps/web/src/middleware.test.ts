import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const mocks = vi.hoisted(() => ({ auth: vi.fn() }))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('@/lib/auth-secret', () => ({ getAuthJwtSecret: () => new TextEncoder().encode('test-secret') }))

import { middleware } from './middleware'

describe('web middleware entrypoint', () => {
  it('lives beside the src app directory so Next.js loads it', () => {
    expect(existsSync(fileURLToPath(new URL('./middleware.ts', import.meta.url)))).toBe(true)
  })

  it('keeps Node-only authentication dependencies out of the Edge bundle', () => {
    const source = readFileSync(fileURLToPath(new URL('./middleware.ts', import.meta.url)), 'utf8')

    expect(source).not.toContain("from '@/lib/auth'")
    expect(source).not.toContain("from '@/lib/db'")
    expect(source).not.toContain("from '@prisma/client'")
    expect(source).not.toContain("from 'bcryptjs'")
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
    const request = new NextRequest('http://localhost/admin')
    request.cookies.set('authjs.session-token', 'present')

    const response = await middleware(request)

    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  })

  it('redirects page requests without a session cookie', async () => {
    const response = await middleware(new NextRequest('http://localhost/dashboard'))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/login?callbackUrl=%2Fdashboard')
  })
})
