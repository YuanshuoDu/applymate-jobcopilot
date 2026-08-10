import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findGmailConnection: vi.fn(),
  syncGmailForUser: vi.fn(),
  recommendationsFindMany: vi.fn(),
  recommendationsUpdate: vi.fn(),
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
    gmailRecommendation: { findMany: mocks.recommendationsFindMany, update: mocks.recommendationsUpdate },
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
    mocks.recommendationsUpdate.mockResolvedValue({})
    mocks.recommendationsFindMany.mockResolvedValue([
      { id: 'recommendation-1', status: 'pending', platform: 'Indeed', company: 'Acme', role: 'Data Engineer', location: 'Dublin, County Dublin', savedJob: null },
      { id: 'recommendation-2', status: 'saved', platform: 'Indeed', company: 'Acme', role: 'Senior Engineer', location: 'Berlin', savedJob: { id: 'job-1', company: 'Acme', role: 'Senior Engineer' } },
    ])
  })

  it('returns an auth error before inspecting Gmail data', async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const { GET } = await import('./route')

    const response = await GET(new Request('http://localhost/api/gmail/tracking?refresh=1') as never)

    expect(response.status).toBe(401)
    expect(mocks.findGmailConnection).not.toHaveBeenCalled()
    expect(mocks.syncGmailForUser).not.toHaveBeenCalled()
  }, 10_000)

  it('syncs only when the caller explicitly refreshes and returns the recommendation queue', async () => {
    const { GET } = await import('./route')

    const response = await GET(new Request('http://localhost/api/gmail/tracking?refresh=1') as never)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      sync: { importedMessages: 2, statusUpdates: 1, newRecommendations: 2 },
      pendingRecommendationCount: 1,
    })
    expect(body.recommendations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'recommendation-1' })]))
    expect(mocks.findGmailConnection).toHaveBeenCalledWith('user-1')
    expect(mocks.syncGmailForUser).toHaveBeenCalledWith('user-1')
    expect(mocks.recommendationsFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' }, take: 100 }))
  }, 10_000)

  it('returns stored Gmail data without a remote sync during navigation', async () => {
    const { GET } = await import('./route')
    mocks.syncGmailForUser.mockClear()

    const response = await GET(new Request('http://localhost/api/gmail/tracking') as never)

    expect(response.status).toBe(200)
    expect(mocks.syncGmailForUser).not.toHaveBeenCalled()
  })

  it('returns one visible row for repeated alerts of the same job', async () => {
    mocks.recommendationsFindMany.mockResolvedValue([
      { id: 'older', status: 'pending', platform: 'Indeed', company: null, role: 'Data Engineer', location: null, description: null, url: 'https://ie.indeed.com/jobs?q=data+engineer', savedJob: null },
      { id: 'newer', status: 'pending', platform: 'Indeed', company: 'Acme', role: 'Data Engineer', location: 'Dublin, County Dublin', description: 'Full role description', url: 'https://ie.indeed.com/viewjob?jk=2', savedJob: null },
    ])
    const { GET } = await import('./route')

    const response = await GET(new Request('http://localhost/api/gmail/tracking') as never)

    await expect(response.json()).resolves.toMatchObject({
      pendingRecommendationCount: 1,
      recommendations: [expect.objectContaining({ id: 'newer', location: 'Dublin, County Dublin' })],
    })
  })

  it('repairs older recommendation fields from its captured email excerpt', async () => {
    mocks.recommendationsFindMany.mockResolvedValue([{
      id: 'legacy', status: 'pending', platform: 'Indeed', company: null, role: 'Creative Design Intern', location: null, salary: null,
      description: null, url: 'https://ie.indeed.com/rc/clk/dl?jk=role-1', savedJob: null,
      sourceMessage: {
        gmailMessageId: 'gmail-1', gmailThreadId: null, subject: 'Your Indeed job alert', excerpt: 'Creative Design Intern\nTrinity College Dublin Students Union - Dublin, County Dublin\nExperience designing digital campaigns, social media assets, and print materials for a growing student-led organisation.\nhttps://ie.indeed.com/rc/clk/dl?jk=role-1',
        receivedAt: new Date('2026-07-29'), senderName: 'Indeed', senderEmail: 'alerts@indeed.com', matchConfidence: 1,
      },
    }])
    const { GET } = await import('./route')

    const response = await GET(new Request('http://localhost/api/gmail/tracking?refresh=1') as never)

    await expect(response.json()).resolves.toMatchObject({
      recommendations: [expect.objectContaining({ company: 'Trinity College Dublin Students Union', location: 'Dublin, County Dublin' })],
    })
    expect(mocks.recommendationsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'legacy' },
      data: expect.objectContaining({ company: 'Trinity College Dublin Students Union', location: 'Dublin, County Dublin' }),
    }))
  })
})
