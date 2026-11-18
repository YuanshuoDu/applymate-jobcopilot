import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GmailRemoteMessage } from './gmail-client'

const mocks = vi.hoisted(() => {
  const state = {
    getGoogleAccessToken: vi.fn(),
    fetchRecentGmailMessages: vi.fn(),
    syncStateUpsert: vi.fn(),
    syncStateUpdate: vi.fn(),
    transaction: vi.fn(),
    jobsFindMany: vi.fn(),
    jobsFindFirst: vi.fn(),
    jobsUpdateMany: vi.fn(),
    acquireFence: vi.fn(),
    purgeCoverLetters: vi.fn(),
    messagesFindUnique: vi.fn(),
    messagesFindMany: vi.fn(),
    messagesCreate: vi.fn(),
    messagesUpdate: vi.fn(),
    recommendationsCreate: vi.fn(),
    activitiesCreate: vi.fn(),
    notificationsFindFirst: vi.fn(),
    notificationsCreate: vi.fn(),
    userFindUnique: vi.fn(),
  }
  state.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    job: { findFirst: state.jobsFindFirst, updateMany: state.jobsUpdateMany },
    gmailMessage: { create: state.messagesCreate },
  }))
  return state
})

vi.mock('@/lib/gmail-helpers', () => ({ getGoogleAccessToken: mocks.getGoogleAccessToken }))
vi.mock('./gmail-client', () => ({ fetchRecentGmailMessages: mocks.fetchRecentGmailMessages }))
vi.mock('@/lib/agent/source-material-fence', () => ({ acquireSourceMaterialFence: mocks.acquireFence }))
vi.mock('@/lib/cover-letter-retention', () => ({ purgeTemporaryGeneratedCoverLetters: mocks.purgeCoverLetters }))
vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    gmailSyncState: { upsert: mocks.syncStateUpsert, update: mocks.syncStateUpdate },
    job: { findMany: mocks.jobsFindMany, findFirst: mocks.jobsFindFirst, updateMany: mocks.jobsUpdateMany },
    gmailMessage: { findUnique: mocks.messagesFindUnique, findMany: mocks.messagesFindMany, create: mocks.messagesCreate, update: mocks.messagesUpdate },
    gmailRecommendation: { create: mocks.recommendationsCreate },
    activity: { create: mocks.activitiesCreate },
    notification: { findFirst: mocks.notificationsFindFirst, create: mocks.notificationsCreate },
    user: { findUnique: mocks.userFindUnique },
  },
}))

import { syncGmailForUser } from './sync'

const receivedAt = new Date('2026-07-29T09:00:00Z')

function remoteMessage(overrides: Partial<GmailRemoteMessage> = {}): GmailRemoteMessage {
  return {
    id: 'gmail-1',
    threadId: 'thread-1',
    senderEmail: 'talent@acme.example',
    senderName: 'Acme Talent',
    subject: 'Application received: Senior Data Engineer at Acme Labs',
    snippet: 'Thank you for applying',
    text: 'Thank you for applying',
    html: '',
    receivedAt,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getGoogleAccessToken.mockResolvedValue('access-token')
  mocks.fetchRecentGmailMessages.mockResolvedValue([])
  mocks.syncStateUpsert.mockResolvedValue({ lastSyncedAt: null })
  mocks.syncStateUpdate.mockResolvedValue({})
  mocks.jobsFindMany.mockResolvedValue([])
  mocks.jobsFindFirst.mockResolvedValue({
    id: 'job-1', company: 'Acme Labs', role: 'Senior Data Engineer',
    status: 'saved', workflowState: 'ready_to_apply', appliedAt: null,
  })
  mocks.jobsUpdateMany.mockResolvedValue({ count: 1 })
  mocks.acquireFence.mockResolvedValue(undefined)
  mocks.purgeCoverLetters.mockResolvedValue(0)
  mocks.messagesFindUnique.mockResolvedValue(null)
  mocks.messagesFindMany.mockResolvedValue([])
  mocks.messagesCreate.mockResolvedValue({ id: 'tracked-1' })
  mocks.messagesUpdate.mockResolvedValue({})
  mocks.recommendationsCreate.mockResolvedValue({})
  mocks.activitiesCreate.mockResolvedValue({})
  mocks.notificationsFindFirst.mockResolvedValue(null)
  mocks.notificationsCreate.mockResolvedValue({})
  mocks.userFindUnique.mockResolvedValue({ preferences: {} })
})

describe('syncGmailForUser', () => {
  it('returns a disconnected result without touching persistence when Gmail is unavailable', async () => {
    mocks.getGoogleAccessToken.mockResolvedValue(null)

    await expect(syncGmailForUser('user-1', receivedAt)).resolves.toEqual({
      connected: false, importedMessages: 0, matchedMessages: 0, statusUpdates: 0, newRecommendations: 0, error: null,
    })
    expect(mocks.syncStateUpsert).not.toHaveBeenCalled()
  })

  it('persists a matched receipt, advances Saved to Applied, and creates evidence', async () => {
    mocks.fetchRecentGmailMessages.mockResolvedValue([remoteMessage()])
    mocks.jobsFindMany.mockResolvedValue([
      { id: 'job-1', company: 'Acme Labs', role: 'Senior Data Engineer', status: 'saved', appliedAt: null },
    ])

    const result = await syncGmailForUser('user-1', receivedAt)

    expect(result).toEqual({ connected: true, importedMessages: 1, matchedMessages: 1, statusUpdates: 1, newRecommendations: 0, error: null })
    expect(mocks.messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ gmailMessageId: 'gmail-1', kind: 'application_received', jobId: 'job-1', matchConfidence: 1 }),
    }))
    expect(mocks.acquireFence).toHaveBeenCalledWith(expect.any(Object), ['user-1'])
    expect(mocks.jobsFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-1', userId: 'user-1' },
      select: expect.objectContaining({ status: true, workflowState: true, appliedAt: true }),
    }))
    expect(mocks.jobsUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'job-1', userId: 'user-1', status: 'saved',
        workflowState: 'ready_to_apply', appliedAt: null,
      },
      data: expect.objectContaining({ status: 'applied', workflowState: 'submitted', appliedAt: receivedAt }),
    }))
    expect(mocks.purgeCoverLetters).toHaveBeenCalledWith('user-1', 'job-1')
    expect(mocks.activitiesCreate).toHaveBeenCalledOnce()
    expect(mocks.notificationsCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'gmail_application_update', jobId: 'job-1' }),
    }))
  })

  it('is idempotent for a Gmail message that was already imported', async () => {
    mocks.fetchRecentGmailMessages.mockResolvedValue([remoteMessage()])
    mocks.messagesFindUnique.mockResolvedValue({ id: 'tracked-1' })

    const result = await syncGmailForUser('user-1', receivedAt)

    expect(result).toEqual({ connected: true, importedMessages: 0, matchedMessages: 0, statusUpdates: 0, newRecommendations: 0, error: null })
    expect(mocks.messagesCreate).not.toHaveBeenCalled()
    expect(mocks.jobsUpdateMany).not.toHaveBeenCalled()
  })

  it('keeps the cursor unchanged after a fenced transaction fails and retries the status-bearing message', async () => {
    mocks.fetchRecentGmailMessages.mockResolvedValue([remoteMessage()])
    mocks.jobsFindMany.mockResolvedValue([
      { id: 'job-1', company: 'Acme Labs', role: 'Senior Data Engineer', status: 'saved', appliedAt: null },
    ])
    mocks.acquireFence.mockRejectedValueOnce(new Error('source fence unavailable'))

    const first = await syncGmailForUser('user-1', receivedAt)

    expect(first).toEqual(expect.objectContaining({ importedMessages: 0, statusUpdates: 0, error: 'Gmail sync has messages that need retry' }))
    expect(mocks.syncStateUpdate).toHaveBeenNthCalledWith(1, {
      where: { userId: 'user-1' }, data: { lastError: 'Gmail sync has messages that need retry' },
    })
    expect(mocks.messagesCreate).not.toHaveBeenCalled()
    expect(mocks.activitiesCreate).not.toHaveBeenCalled()
    expect(mocks.notificationsCreate).not.toHaveBeenCalled()
    expect(mocks.purgeCoverLetters).not.toHaveBeenCalled()

    const retry = await syncGmailForUser('user-1', receivedAt)

    expect(retry).toEqual(expect.objectContaining({ importedMessages: 1, matchedMessages: 1, statusUpdates: 1, error: null }))
    expect(mocks.messagesCreate).toHaveBeenCalledOnce()
    expect(mocks.jobsUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.activitiesCreate).toHaveBeenCalledOnce()
  })

  it('holds a three-day-old CAS miss for retry while processing later mail only once', async () => {
    const now = new Date('2026-11-18T10:00:00Z')
    const oldReceivedAt = new Date('2026-11-15T10:00:00Z')
    const existingCursor = new Date('2026-11-16T10:00:00Z')
    const oldMessage = remoteMessage({
      id: 'gmail-old-cas-miss',
      receivedAt: oldReceivedAt,
    })
    const laterMessage = remoteMessage({
      id: 'gmail-later-success',
      senderEmail: 'talent@beta.example',
      subject: 'Interview invitation: Staff Engineer at Beta Systems',
      snippet: 'Please schedule an interview with our team.',
      text: 'Please schedule an interview with our team.',
      receivedAt: new Date('2026-11-17T10:00:00Z'),
    })
    const storedMessages = new Map<string, { id: string; kind: string }>()

    mocks.syncStateUpsert.mockResolvedValue({ lastSyncedAt: existingCursor })
    mocks.fetchRecentGmailMessages.mockResolvedValue([oldMessage, laterMessage])
    mocks.jobsFindMany.mockResolvedValue([
      { id: 'job-1', company: 'Acme Labs', role: 'Senior Data Engineer', status: 'saved', appliedAt: null },
      { id: 'job-2', company: 'Beta Systems', role: 'Staff Engineer', status: 'saved', appliedAt: null },
    ])
    mocks.jobsFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => where.id === 'job-2'
      ? { id: 'job-2', company: 'Beta Systems', role: 'Staff Engineer', status: 'saved', workflowState: 'ready_to_apply', appliedAt: null }
      : { id: 'job-1', company: 'Acme Labs', role: 'Senior Data Engineer', status: 'saved', workflowState: 'ready_to_apply', appliedAt: null })
    mocks.jobsUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 })
    mocks.messagesFindUnique.mockImplementation(async ({ where }: { where: { userId_gmailMessageId: { gmailMessageId: string } } }) => {
      const found = storedMessages.get(where.userId_gmailMessageId.gmailMessageId)
      return found ? { ...found, scheduledAt: null } : null
    })
    mocks.messagesCreate.mockImplementation(async ({ data }: { data: { gmailMessageId: string; kind: string } }) => {
      const created = { id: 'tracked-' + data.gmailMessageId, kind: data.kind }
      storedMessages.set(data.gmailMessageId, created)
      return created
    })

    const first = await syncGmailForUser('user-1', now)

    expect(first).toEqual({
      connected: true, importedMessages: 1, matchedMessages: 1, statusUpdates: 1,
      newRecommendations: 0, error: 'Gmail sync has messages that need retry',
    })
    expect(mocks.messagesCreate).toHaveBeenCalledOnce()
    expect(mocks.messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ gmailMessageId: 'gmail-later-success' }),
    }))
    expect(mocks.syncStateUpdate).toHaveBeenNthCalledWith(1, {
      where: { userId: 'user-1' }, data: { lastError: 'Gmail sync has messages that need retry' },
    })

    const retry = await syncGmailForUser('user-1', now)

    expect(retry).toEqual({
      connected: true, importedMessages: 1, matchedMessages: 1, statusUpdates: 1,
      newRecommendations: 0, error: null,
    })
    expect(mocks.messagesCreate).toHaveBeenCalledTimes(2)
    expect(mocks.messagesCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({ gmailMessageId: 'gmail-old-cas-miss' }),
    }))
    expect(mocks.fetchRecentGmailMessages.mock.calls.map((call) => call[1])).toEqual([
      new Date('2026-11-15T10:00:00Z'), new Date('2026-11-15T10:00:00Z'),
    ])
    expect(mocks.syncStateUpdate).toHaveBeenNthCalledWith(2, {
      where: { userId: 'user-1' }, data: { lastSyncedAt: now, lastError: null },
    })
    expect(mocks.jobsUpdateMany).toHaveBeenCalledTimes(3)
    expect(mocks.activitiesCreate.mock.calls.filter(([call]) => call.data.jobId === 'job-2')).toHaveLength(1)
    expect(mocks.notificationsCreate.mock.calls.filter(([call]) => call.data.jobId === 'job-2')).toHaveLength(1)
  })

  it('keeps the cursor behind after an uncertain commit and never repeats its side effects', async () => {
    const now = new Date('2026-11-18T10:00:00Z')
    const existingCursor = new Date('2026-11-16T10:00:00Z')
    const message = remoteMessage({ receivedAt: new Date('2026-11-15T10:00:00Z') })
    const storedMessages = new Map<string, { id: string; kind: string }>()

    mocks.syncStateUpsert.mockResolvedValue({ lastSyncedAt: existingCursor })
    mocks.fetchRecentGmailMessages.mockResolvedValue([message])
    mocks.jobsFindMany.mockResolvedValue([
      { id: 'job-1', company: 'Acme Labs', role: 'Senior Data Engineer', status: 'saved', appliedAt: null },
    ])
    mocks.messagesFindUnique.mockImplementation(async ({ where }: { where: { userId_gmailMessageId: { gmailMessageId: string } } }) => {
      const found = storedMessages.get(where.userId_gmailMessageId.gmailMessageId)
      return found ? { ...found, scheduledAt: null } : null
    })
    mocks.messagesCreate.mockImplementation(async ({ data }: { data: { gmailMessageId: string; kind: string } }) => {
      const created = { id: 'tracked-' + data.gmailMessageId, kind: data.kind }
      storedMessages.set(data.gmailMessageId, created)
      return created
    })
    mocks.transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
      await callback({
        job: { findFirst: mocks.jobsFindFirst, updateMany: mocks.jobsUpdateMany },
        gmailMessage: { create: mocks.messagesCreate },
      })
      throw new Error('connection lost while commit outcome was unknown')
    })

    const first = await syncGmailForUser('user-1', now)

    expect(first).toEqual(expect.objectContaining({
      importedMessages: 0, matchedMessages: 0, statusUpdates: 0,
      error: 'Gmail sync has messages that need retry',
    }))
    expect(mocks.syncStateUpdate).toHaveBeenNthCalledWith(1, {
      where: { userId: 'user-1' }, data: { lastError: 'Gmail sync has messages that need retry' },
    })
    expect(mocks.messagesCreate).toHaveBeenCalledOnce()
    expect(mocks.activitiesCreate).not.toHaveBeenCalled()
    expect(mocks.notificationsCreate).not.toHaveBeenCalled()
    expect(mocks.purgeCoverLetters).not.toHaveBeenCalled()

    const retry = await syncGmailForUser('user-1', now)

    expect(retry).toEqual(expect.objectContaining({ importedMessages: 0, statusUpdates: 0, error: null }))
    expect(mocks.fetchRecentGmailMessages.mock.calls.map((call) => call[1])).toEqual([
      new Date('2026-11-15T10:00:00Z'), new Date('2026-11-15T10:00:00Z'),
    ])
    expect(mocks.jobsUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.messagesCreate).toHaveBeenCalledOnce()
    expect(mocks.activitiesCreate).not.toHaveBeenCalled()
    expect(mocks.notificationsCreate).not.toHaveBeenCalled()
    expect(mocks.purgeCoverLetters).not.toHaveBeenCalled()
  })

  it('honours the apply notification preference for Gmail application updates', async () => {
    mocks.userFindUnique.mockResolvedValue({ preferences: { notificationPreferences: { apply: false } } })
    mocks.fetchRecentGmailMessages.mockResolvedValue([remoteMessage()])
    mocks.jobsFindMany.mockResolvedValue([
      { id: 'job-1', company: 'Acme Labs', role: 'Senior Data Engineer', status: 'saved', appliedAt: null },
    ])

    await syncGmailForUser('user-1', receivedAt)

    expect(mocks.notificationsCreate).not.toHaveBeenCalled()
  })

  it('backfills a concrete interview schedule from an already tracked email', async () => {
    mocks.messagesFindMany.mockResolvedValue([{
      id: 'tracked-interview',
      subject: 'Interview invitation',
      excerpt: 'Your interview is on 31 July 2026 at 10:30 AM.',
      receivedAt,
    }])

    await syncGmailForUser('user-1', receivedAt)

    expect(mocks.messagesUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'tracked-interview' },
      data: { scheduledAt: new Date(2026, 6, 31, 10, 30) },
    }))
  })

  it('persists daily recommendation cards and emits one dashboard notification', async () => {
    mocks.fetchRecentGmailMessages.mockResolvedValue([remoteMessage({
      id: 'digest-1',
      senderEmail: 'mail@indeed.com',
      subject: 'Jobs for you today',
      snippet: 'Recommended jobs',
      text: 'Data Analyst at Northstar | Dublin, Ireland | €60k–€75k\nhttps://www.indeed.com/viewjob?jk=42',
    })])

    const result = await syncGmailForUser('user-1', receivedAt)

    expect(result.newRecommendations).toBe(1)
    expect(mocks.recommendationsCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-1', sourceMessageId: 'tracked-1', company: 'Northstar', role: 'Data Analyst' }),
    }))
    expect(mocks.notificationsCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'gmail_recommendations' }),
    }))
  })

  it('records a recoverable Gmail sync error instead of throwing', async () => {
    mocks.fetchRecentGmailMessages.mockRejectedValue(new Error('Gmail unavailable'))

    await expect(syncGmailForUser('user-1', receivedAt)).resolves.toEqual(expect.objectContaining({
      connected: true,
      error: 'Gmail unavailable',
    }))
    expect(mocks.syncStateUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { lastError: 'Gmail unavailable' },
    }))
  })
})
