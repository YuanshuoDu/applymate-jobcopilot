import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userUpsert: vi.fn(),
  accountFindFirst: vi.fn(),
  accountUpdateMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    user: { upsert: mocks.userUpsert },
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
    mocks.userUpsert.mockResolvedValue({ id: 'target-user', email: 'member@example.com', name: 'Member', image: 'https://example.test/member.png' })
    mocks.accountFindFirst.mockResolvedValue(null)
    mocks.accountUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('leaves a normal verified Google identity unchanged', async () => {
    await expect(reconcileGoogleLoginIdentity({
      user: { email: 'member@example.com' },
      account: { provider: 'google', providerAccountId: 'google-subject' },
      profile: { email: 'Member@Example.com', email_verified: true },
    })).resolves.toBe(true)

    expect(mocks.userUpsert).not.toHaveBeenCalled()
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

    expect(mocks.userUpsert).toHaveBeenCalledWith({
      where: { email: 'member@example.com' },
      update: {},
      create: {
        email: 'member@example.com',
        name: 'Member',
        image: 'https://example.test/member.png',
        emailVerified: expect.any(Date),
      },
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

    expect(mocks.userUpsert).not.toHaveBeenCalled()
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
})
