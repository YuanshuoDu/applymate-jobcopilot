import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  userCreate: vi.fn(),
  accountFindFirst: vi.fn(),
  accountUpdateMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    user: { findMany: mocks.userFindMany, create: mocks.userCreate },
    account: {
      findFirst: mocks.accountFindFirst,
      updateMany: mocks.accountUpdateMany,
    },
  },
}))

import { reconcileGoogleLoginIdentity } from './google-identity'

describe('reconcileGoogleLoginIdentity', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.userFindMany.mockResolvedValue([])
    mocks.userCreate.mockResolvedValue({ id: 'target-user', email: 'member@example.com', name: 'Member', image: 'https://example.test/member.png' })
    mocks.accountFindFirst.mockResolvedValue(null)
    mocks.accountUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('leaves a normal verified Google identity unchanged', async () => {
    await expect(reconcileGoogleLoginIdentity({
      user: { email: 'member@example.com' },
      account: { provider: 'google', providerAccountId: 'google-subject' },
      profile: { email: 'Member@Example.com', email_verified: true },
    })).resolves.toBe(true)

    expect(mocks.userFindMany).not.toHaveBeenCalled()
    expect(mocks.accountUpdateMany).not.toHaveBeenCalled()
  })

  it('repairs a legacy Google identity that points to the demo user', async () => {
    const user = { id: 'demo-user', email: 'demo@applymate.ai', name: 'Zhang Li', image: null as string | null }

    await expect(reconcileGoogleLoginIdentity({
      user,
      account: { provider: 'google', providerAccountId: 'google-subject' },
      profile: {
        email: 'Member@Example.com',
        email_verified: true,
        name: 'Member',
        picture: 'https://example.test/member.png',
      },
    })).resolves.toBe(true)

    expect(user).toMatchObject({
      id: 'target-user',
      email: 'member@example.com',
      name: 'Member',
      image: 'https://example.test/member.png',
    })

    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: { email: { equals: 'member@example.com', mode: 'insensitive' } },
      select: { id: true, email: true, name: true, image: true },
      take: 2,
    })
    expect(mocks.userCreate).toHaveBeenCalledWith({
      data: {
        email: 'member@example.com',
        name: 'Member',
        image: 'https://example.test/member.png',
        emailVerified: expect.any(Date),
      },
      select: { id: true, email: true, name: true, image: true },
    })
    expect(mocks.accountUpdateMany).toHaveBeenCalledWith({
      where: { provider: 'google', providerAccountId: 'google-subject' },
      data: { userId: 'target-user' },
    })
  })

  it('rejects an unverified email before it can change account ownership', async () => {
    await expect(reconcileGoogleLoginIdentity({
      user: { email: 'demo@applymate.ai' },
      account: { provider: 'google', providerAccountId: 'google-subject' },
      profile: { email: 'member@example.com', email_verified: false },
    })).resolves.toBe(false)

    expect(mocks.userCreate).not.toHaveBeenCalled()
    expect(mocks.accountUpdateMany).not.toHaveBeenCalled()
  })

  it('does not overwrite another Google identity already linked to the target user', async () => {
    mocks.accountFindFirst.mockResolvedValue({ providerAccountId: 'different-subject' })

    await expect(reconcileGoogleLoginIdentity({
      user: { email: 'demo@applymate.ai' },
      account: { provider: 'google', providerAccountId: 'google-subject' },
      profile: { email: 'member@example.com', email_verified: true },
    })).resolves.toBe(false)

    expect(mocks.accountUpdateMany).not.toHaveBeenCalled()
  })

  it('reuses the identity created by a concurrent normalized-email insert', async () => {
    mocks.userFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'member-1', email: 'member@example.com', name: 'Member', image: null }])
    mocks.userCreate.mockRejectedValue({ code: 'P2002' })
    mocks.accountFindFirst.mockResolvedValue(null)
    mocks.accountUpdateMany.mockResolvedValue({ count: 1 })

    const user = { id: 'legacy-user', email: 'legacy@example.com', name: 'Legacy', image: null as string | null }
    await expect(reconcileGoogleLoginIdentity({
      user,
      account: { provider: 'google', providerAccountId: 'google-subject' },
      profile: { email: 'member@example.com', email_verified: true },
    })).resolves.toBe(true)

    expect(user.id).toBe('member-1')
  })
})
