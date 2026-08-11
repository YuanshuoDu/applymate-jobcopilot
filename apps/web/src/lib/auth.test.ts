import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  nextAuth: vi.fn((_config: unknown) => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: vi.fn(),
  })),
  findUnique: vi.fn(),
  findMany: vi.fn(),
}))

vi.mock('next-auth', () => ({
  default: mocks.nextAuth,
}))
vi.mock('@auth/prisma-adapter', () => ({
  PrismaAdapter: vi.fn(() => ({})),
}))
vi.mock('next-auth/providers/credentials', () => ({
  default: vi.fn(() => ({})),
}))
vi.mock('next-auth/providers/google', () => ({
  default: vi.fn(() => ({})),
}))
vi.mock('next-auth/providers/github', () => ({
  default: vi.fn(() => ({})),
}))
vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mocks.findUnique, findMany: mocks.findMany, updateMany: vi.fn() },
    adminMembership: { findUnique: vi.fn() },
    account: { updateMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth-secret', () => ({ getAuthSecret: () => 'test-secret' }))
vi.mock('@/lib/google-identity', () => ({ reconcileGoogleLoginIdentity: vi.fn() }))
vi.mock('@/lib/credential-secrets', () => ({ encryptAccountTokenFields: vi.fn() }))
vi.mock('@/lib/auth-runtime-config', () => ({ assertNoAuthOriginOverride: vi.fn() }))
vi.mock('@/lib/credential-authorizer', () => ({ authorizeCredentials: vi.fn() }))

import './auth'

type JwtCallback = (input: { token: Record<string, unknown>; user?: undefined }) => Promise<Record<string, unknown>>
type SessionCallback = (input: {
  session: { user?: Record<string, unknown>; expires?: string }
  token: Record<string, unknown>
}) => Promise<{ user?: Record<string, unknown>; expires?: string }>

function jwtCallback(): JwtCallback {
  const config = mocks.nextAuth.mock.calls[0]?.[0] as { callbacks: { jwt: JwtCallback } } | undefined
  if (!config) throw new Error('Expected NextAuth configuration')
  return config.callbacks.jwt
}

function sessionCallback(): SessionCallback {
  const config = mocks.nextAuth.mock.calls[0]?.[0] as { callbacks: { session: SessionCallback } } | undefined
  if (!config) throw new Error('Expected NextAuth configuration')
  return config.callbacks.session
}

describe('Auth.js JWT callback', () => {
  it('migrates a verified legacy subject claim before candidate APIs consume the session', async () => {
    mocks.findUnique.mockResolvedValue({ accountStatus: 'active', authVersion: 1, plan: 'pro' })

    await expect(jwtCallback()({ token: { sub: 'legacy_user' } })).resolves.toMatchObject({
      sub: 'legacy_user',
      id: 'legacy_user',
      authVersion: 1,
      plan: 'pro',
    })
  })

  it('does not migrate a legacy subject after the account has been suspended', async () => {
    mocks.findUnique.mockResolvedValue({ accountStatus: 'suspended', authVersion: 1, plan: 'pro' })

    await expect(jwtCallback()({ token: { sub: 'legacy_user' } })).resolves.toEqual({})
  })

  it('upgrades an active signed email-only legacy token before candidate APIs consume the session', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'legacy_user', accountStatus: 'active', authVersion: 1, plan: 'pro' }])

    await expect(jwtCallback()({ token: { email: 'Candidate@Example.com' } })).resolves.toMatchObject({
      id: 'legacy_user',
      email: 'Candidate@Example.com',
      authVersion: 1,
      plan: 'pro',
    })
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { email: { equals: 'candidate@example.com', mode: 'insensitive' } },
      select: { id: true, accountStatus: true, authVersion: true, plan: true },
      take: 2,
    })
  })

  it('rejects an email-only legacy token after its authentication version changes', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'legacy_user', accountStatus: 'active', authVersion: 2, plan: 'pro' }])

    await expect(jwtCallback()({ token: { email: 'candidate@example.com' } })).resolves.toEqual({})
  })

  it('rejects an email-only legacy token when historic case variants are ambiguous', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'user_one', accountStatus: 'active', authVersion: 1, plan: 'pro' },
      { id: 'user_two', accountStatus: 'active', authVersion: 1, plan: 'pro' },
    ])

    await expect(jwtCallback()({ token: { email: 'candidate@example.com' } })).resolves.toEqual({})
  })

  it('exposes a legacy Auth.js subject and revision in the web session', async () => {
    const session = { user: { email: 'candidate@example.com' } }

    await expect(sessionCallback()({
      session,
      token: { sub: 'legacy_user', authVersion: 1, plan: 'pro' },
    })).resolves.toMatchObject({
      user: { id: 'legacy_user', authVersion: 1, plan: 'pro' },
    })
  })

  it('removes an unverified session user rather than rendering a zombie application shell', async () => {
    const session = { user: { email: 'candidate@example.com' }, expires: '2026-08-11T17:00:00.000Z' }

    await expect(sessionCallback()({
      session,
      token: { email: 'candidate@example.com' },
    })).resolves.toEqual({ expires: '2026-08-11T17:00:00.000Z' })
  })
})
