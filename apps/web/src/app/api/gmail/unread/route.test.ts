import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findGmailConnection: vi.fn(),
  recommendationCount: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock('@/lib/gmail-helpers', () => ({
  findGmailConnection: mocks.findGmailConnection,
}))

vi.mock('@/lib/db', () => ({
  db: { gmailRecommendation: { count: mocks.recommendationCount } },
}))

describe('GET /api/gmail/unread', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.findGmailConnection.mockReset()
    mocks.recommendationCount.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
  })

  it('reports no badge when Gmail is not connected', async () => {
    mocks.findGmailConnection.mockResolvedValue(null)
    const { GET } = await import('./route')

    const response = await GET()

    await expect(response.json()).resolves.toEqual({ unread: 0, hasGmail: false })
    expect(mocks.recommendationCount).not.toHaveBeenCalled()
  })

  it('uses pending job recommendations instead of raw inbox unread count', async () => {
    mocks.findGmailConnection.mockResolvedValue({ id: 'gmail_account' })
    mocks.recommendationCount.mockResolvedValue(3)
    const { GET } = await import('./route')

    const response = await GET()

    await expect(response.json()).resolves.toEqual({ unread: 3, pendingRecommendations: 3, hasGmail: true })
    expect(mocks.recommendationCount).toHaveBeenCalledWith({
      where: { userId: 'user_1', status: 'pending' },
    })
  })
})
