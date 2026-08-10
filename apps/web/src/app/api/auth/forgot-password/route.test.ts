import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPasswordResetToken } from '@/lib/password-reset'

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  tokenDeleteMany: vi.fn(),
  tokenCreate: vi.fn(),
  fetch: vi.fn(),
}))
const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)))

vi.mock('@/lib/db', () => ({
  db: {
    user: { findFirst: mocks.userFindFirst },
    verificationToken: {
      deleteMany: mocks.tokenDeleteMany,
      create: mocks.tokenCreate,
    },
  },
}))

vi.mock('@/lib/api-helpers', () => ({
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@jobcopilot/shared', async () => {
  const actual = await vi.importActual<typeof import('@jobcopilot/shared')>('@jobcopilot/shared')
  return { ...actual, pinnedFetch }
})

function request(body: unknown) {
  return new Request('http://localhost:3000/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('forgot password API', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    vi.stubEnv('RESEND_API_KEY', 'resend_test_key')
    vi.stubEnv('EMAIL_FROM', 'ApplyMate <no-reply@example.test>')
    vi.stubEnv('NEXTAUTH_URL', 'https://applymate.example')
    vi.stubGlobal('fetch', mocks.fetch)
    mocks.userFindFirst.mockResolvedValue({ id: 'user_1' })
    mocks.tokenDeleteMany.mockResolvedValue({ count: 1 })
    mocks.tokenCreate.mockResolvedValue({ token: 'stored' })
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('normalizes email, stores only a hash, and sends a one-time reset link', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ email: '  Member@Example.COM ' }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(mocks.userFindFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'member@example.com', mode: 'insensitive' } },
      select: { id: true },
    })

    const tokenData = mocks.tokenCreate.mock.calls[0][0].data as {
      identifier: string
      token: string
      expires: Date
    }
    expect(tokenData.identifier).toBe('password-reset:user_1')
    expect(tokenData.token).toMatch(/^[a-f0-9]{64}$/)
    expect(tokenData.expires.getTime()).toBeGreaterThan(Date.now())

    const emailPayload = JSON.parse(mocks.fetch.mock.calls[0][1].body) as { html: string; to: string[] }
    expect(emailPayload.to).toEqual(['member@example.com'])
    const resetLink = emailPayload.html.match(/href="([^"]+)"/)?.[1]
    expect(resetLink).toBeTruthy()
    const rawToken = new URL(resetLink as string).searchParams.get('token')
    expect(rawToken).toBeTruthy()
    expect(hashPasswordResetToken(rawToken as string)).toBe(tokenData.token)
  })

  it('does not reveal whether an address belongs to an account', async () => {
    mocks.userFindFirst.mockResolvedValue(null)
    const { POST } = await import('./route')
    const response = await POST(request({ email: 'missing@example.com' }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(mocks.tokenCreate).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('returns a truthful configuration error without creating a token', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    const { POST } = await import('./route')
    const response = await POST(request({ email: 'member@example.com' }) as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'Password reset email is not configured. Set RESEND_API_KEY and EMAIL_FROM.',
    })
    expect(mocks.userFindFirst).not.toHaveBeenCalled()
    expect(mocks.tokenCreate).not.toHaveBeenCalled()
  })

  it('removes the stored token when Resend cannot deliver without leaking account existence', async () => {
    mocks.fetch.mockResolvedValue(new Response('unavailable', { status: 503 }))
    const { POST } = await import('./route')
    const response = await POST(request({ email: 'member@example.com' }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(mocks.tokenDeleteMany).toHaveBeenCalledTimes(2)
    expect(mocks.tokenDeleteMany.mock.calls[1][0]).toEqual({
      where: expect.objectContaining({ identifier: 'password-reset:user_1', token: expect.any(String) }),
    })
  })
})
