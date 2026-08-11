import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  jwtVerify: vi.fn(),
  membershipFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  userFindUnique: vi.fn(),
}))

vi.mock('bcryptjs', () => ({ default: { compare: mocks.compare } }))
vi.mock('jose', () => ({ jwtVerify: mocks.jwtVerify }))
vi.mock('@/lib/db', () => ({
  db: {
    user: { findMany: mocks.userFindMany, findUnique: mocks.userFindUnique },
    adminMembership: { findUnique: mocks.membershipFindUnique },
  },
}))
vi.mock('@/lib/auth-secret', () => ({
  EXTENSION_TOKEN_AUDIENCE: 'applymate-extension',
  EXTENSION_TOKEN_ISSUER: 'applymate-extension',
  getAuthJwtSecret: () => new TextEncoder().encode('test-auth-jwt-secret'),
}))

import { authorizeCredentials } from './credential-authorizer'

const activeUser = {
  id: 'user_1', email: 'user@example.com', name: 'Candidate', image: null,
  password: 'hashed-password', accountStatus: 'active',
}

describe('credential authorization by host', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.compare.mockResolvedValue(true)
    mocks.userFindMany.mockResolvedValue([activeUser])
    mocks.membershipFindUnique.mockResolvedValue({ status: 'active' })
  })

  it('accepts an active administrator membership on the administrator host', async () => {
    const user = await authorizeCredentials(
      { email: 'USER@example.com', password: 'password' },
      new Request('https://admin.applymate.site/api/auth/callback/credentials'),
    )

    expect(user).toMatchObject({ id: 'user_1', email: 'user@example.com' })
    expect(mocks.membershipFindUnique).toHaveBeenCalledWith({ where: { userId: 'user_1' }, select: { status: true } })
  })

  it('rejects a normal account on the administrator host after validating its password', async () => {
    mocks.membershipFindUnique.mockResolvedValue(null)

    const user = await authorizeCredentials(
      { email: 'user@example.com', password: 'password' },
      new Request('https://admin.applymate.site/api/auth/callback/credentials'),
    )

    expect(user).toBeNull()
    expect(mocks.compare).toHaveBeenCalledWith('password', 'hashed-password')
  })

  it('does not require an administrator membership for a public-host credential login', async () => {
    const user = await authorizeCredentials(
      { email: 'user@example.com', password: 'password' },
      new Request('https://applymate.site/api/auth/callback/credentials'),
    )

    expect(user).toMatchObject({ id: 'user_1' })
    expect(mocks.membershipFindUnique).not.toHaveBeenCalled()
  })

  it('rejects ambiguous case-insensitive email matches before password verification', async () => {
    mocks.userFindMany.mockResolvedValue([activeUser, { ...activeUser, id: 'user_2' }])

    const user = await authorizeCredentials(
      { email: 'user@example.com', password: 'password' },
      new Request('https://applymate.site/api/auth/callback/credentials'),
    )

    expect(user).toBeNull()
    expect(mocks.compare).not.toHaveBeenCalled()
    expect(mocks.userFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }))
  })

  it('rejects extension tokens on the administrator host before token verification', async () => {
    const user = await authorizeCredentials(
      { token: 'extension-token' },
      new Request('https://admin.applymate.site/api/auth/callback/credentials'),
    )

    expect(user).toBeNull()
    expect(mocks.jwtVerify).not.toHaveBeenCalled()
  })
})
