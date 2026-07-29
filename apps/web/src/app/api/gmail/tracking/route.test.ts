import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findGmailConnection: vi.fn(),
  syncGmailForUser: vi.fn(),
  messagesFindMany: vi.fn(),
  recommendationsFindMany: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/gmail-helpers', () => ({ findGmailConnection: mocks.findGmailConnection }))
vi.mock('@/lib/gmail-tracking/sync', () => ({ syncGmailForUser: mocks.syncGmailForUser }))
vi.mock('@/lib/db', () => ({
  db: {
    gmailMessage: { findMany: mocks.messagesFindMany },
    gmailRecommendation: { findMany: mocks.recommendationsFindMany },
  },
}))

describe('GET /api/gmail/tracking', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.findGmailConnection.mockResolvedValue({ id: 'account-1' })
    mocks.syncGmailForUser.mockResolvedValue({
      connected: true,
      importedMessages: 2,
      matchedMessages: 1,
      statusUpdates: 1,
      newRecommendations: 2,
      error: null,
    })
    mocks.messagesFindMany.mockResolvedValue([{ id: 'message-1', subject: 'Application received', job: null }])
    mocks.recommendationsFindMany.mockResolvedValue([
      { id: 'recommendation-1', status: 'pending', savedJob: null },
      { id: 'recommendation-2', status: 'saved', savedJob: { id: 'job-1', company: 'Acme', role: 'Engineer' } },
    ])
  })

  it('returns an auth error before inspecting Gmail data', async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const { GET } = await import('./route')

    const response = await GET(new Request('http://localhost/api/gmail/tracking') as never)

    expect(response.status).toBe(401)
    expect(mocks.findGmailConnection).not.toHaveBeenCalled()
    expect(mocks.syncGmailForUser).not.toHaveBeenCalled()
  })

  it('syncs the signed-in account and returns tracked email evidence with global pending recommendations', async () => {
    const { GET } = await import('./route')

    const response = await GET(new Request('http://localhost/api/gmail/tracking') as never)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      sync: { importedMessages: 2, statusUpdates: 1, newRecommendations: 2 },
      pendingRecommendationCount: 1,
    })
    expect(body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'message-1' })]))
    expect(body.recommendations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'recommendation-1' })]))
    expect(mocks.findGmailConnection).toHaveBeenCalledWith('user-1')
    expect(mocks.syncGmailForUser).toHaveBeenCalledWith('user-1')
    expect(mocks.messagesFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' }, take: 80 }))
    expect(mocks.recommendationsFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' }, take: 100 }))
  })
})
