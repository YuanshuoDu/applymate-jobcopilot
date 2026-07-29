import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  accountsFindMany: vi.fn(),
  syncGmailForUser: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { account: { findMany: mocks.accountsFindMany } } }))
vi.mock('@/lib/gmail-tracking/sync', () => ({ syncGmailForUser: mocks.syncGmailForUser }))

function cronRequest(headers?: HeadersInit) {
  return new Request('http://localhost/api/gmail/sync/daily', { method: 'POST', headers })
}

describe('daily Gmail sync API', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.accountsFindMany.mockReset()
    mocks.syncGmailForUser.mockReset()
    vi.stubEnv('GMAIL_SYNC_CRON_SECRET', 'gmail-cron-secret')
    vi.stubEnv('CRON_SECRET', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rejects a daily sync request without the configured secret', async () => {
    const { POST } = await import('./route')

    const response = await POST(cronRequest() as never)

    expect(response.status).toBe(401)
    expect(mocks.accountsFindMany).not.toHaveBeenCalled()
  })

  it('syncs each distinct connected Gmail account and aggregates daily recommendations', async () => {
    mocks.accountsFindMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }])
    mocks.syncGmailForUser
      .mockResolvedValueOnce({ connected: true, importedMessages: 3, matchedMessages: 1, statusUpdates: 1, newRecommendations: 2, error: null })
      .mockResolvedValueOnce({ connected: true, importedMessages: 1, matchedMessages: 0, statusUpdates: 0, newRecommendations: 1, error: null })
    const { POST } = await import('./route')

    const response = await POST(cronRequest({ authorization: 'Bearer gmail-cron-secret' }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ checked: 2, synced: 2, recommendations: 3 })
    expect(mocks.accountsFindMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { provider: 'gmail' },
          { provider: 'google', scope: { contains: 'gmail' } },
        ],
      },
      select: { userId: true },
      distinct: ['userId'],
      take: 100,
    })
    expect(mocks.syncGmailForUser).toHaveBeenCalledWith('user-1')
    expect(mocks.syncGmailForUser).toHaveBeenCalledWith('user-2')
  })
})
