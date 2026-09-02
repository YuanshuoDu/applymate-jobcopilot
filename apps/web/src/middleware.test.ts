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

  it('keeps the canonical Landing route public even with an active session', async () => {
    const request = new NextRequest('https://applymate.site/landing')
    request.cookies.set('authjs.session-token', 'present')

    const response = await middleware(request)

    expect(response.status).toBe(200)
  })

  it('keeps the local Agent preview accessible without a session', async () => {
    const response = await middleware(new NextRequest('http://localhost/agent-preview'))

    expect(response.status).toBe(200)
  })

  it('does not expose the local Agent preview on a public hostname', async () => {
    const response = await middleware(new NextRequest('https://applymate.site/agent-preview'))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/login?callbackUrl=%2Fagent-preview')
  })

  it('sends the administrator host root to the protected admin entrypoint', async () => {
    const response = await middleware(new NextRequest('https://admin.applymate.site/'))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://admin.applymate.site/admin')
  })

  it('keeps ordinary pages off the administrator host', async () => {
    const response = await middleware(new NextRequest('https://admin.applymate.site/jobs'))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://admin.applymate.site/admin')
  })

  it('moves admin pages from production and preview hosts to the administrator origin', async () => {
    const response = await middleware(new NextRequest('https://applymate.site/admin/plans?tab=limits'))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://admin.applymate.site/admin/plans?tab=limits')
  })

  it('keeps administrator invitations on the administrator origin', async () => {
    const page = await middleware(new NextRequest('https://applymate.site/invite/admin?token=invite-token'))
    const api = await middleware(new NextRequest('https://applymate.site/api/admin/invitations/accept'))

    expect(page.status).toBe(307)
    expect(page.headers.get('location')).toBe('https://admin.applymate.site/invite/admin?token=invite-token')
    expect(api.status).toBe(404)
  })

  it('does not expose admin APIs on the ordinary production host', async () => {
    const response = await middleware(new NextRequest('https://applymate.site/api/admin/v1/users'))

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store, private')
  })

  it('keeps the administrator login public while restricting other APIs', async () => {
    const login = await middleware(new NextRequest('https://admin.applymate.site/login?callbackUrl=%2Fadmin'))
    const api = await middleware(new NextRequest('https://admin.applymate.site/api/jobs'))

    expect(login.status).toBe(200)
    expect(api.status).toBe(404)
  })

  it('keeps public registration off the administrator host', async () => {
    const page = await middleware(new NextRequest('https://admin.applymate.site/register'))
    const api = await middleware(new NextRequest('https://admin.applymate.site/api/auth/register', { method: 'POST' }))
    const invitationRegistration = await middleware(new NextRequest('https://admin.applymate.site/api/admin/invitations/register', { method: 'POST' }))

    expect(page.status).toBe(307)
    expect(page.headers.get('location')).toBe('https://admin.applymate.site/login?callbackUrl=%2Fadmin&error=admin_registration_disabled')
    expect(api.status).toBe(404)
    expect(api.headers.get('X-Frame-Options')).toBe('DENY')
    expect(invitationRegistration.status).toBe(200)
    expect(invitationRegistration.headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('allows the Auth.js endpoints required for credential sign-in while blocking other providers', async () => {
    const csrf = await middleware(new NextRequest('https://admin.applymate.site/api/auth/csrf'))
    const credentials = await middleware(new NextRequest('https://admin.applymate.site/api/auth/callback/credentials', { method: 'POST' }))
    const providers = await middleware(new NextRequest('https://admin.applymate.site/api/auth/providers'))
    const oauth = await middleware(new NextRequest('https://admin.applymate.site/api/auth/signin/google'))
    const extension = await middleware(new NextRequest('https://admin.applymate.site/api/auth/extension-token', { method: 'POST' }))

    expect(csrf.status).toBe(200)
    expect(credentials.status).toBe(200)
    expect(providers.status).toBe(200)
    for (const response of [oauth, extension]) {
      expect(response.status).toBe(404)
      expect(response.headers.get('Cache-Control')).toBe('no-store, private')
    }
  })
})
