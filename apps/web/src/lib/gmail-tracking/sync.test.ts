import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GmailRemoteMessage } from './gmail-client'

const mocks = vi.hoisted(() => ({
  getGoogleAccessToken: vi.fn(),
  fetchRecentGmailMessages: vi.fn(),
  syncStateUpsert: vi.fn(),
  syncStateUpdate: vi.fn(),
  jobsFindMany: vi.fn(),
  jobsUpdate: vi.fn(),
  messagesFindUnique: vi.fn(),
  messagesFindMany: vi.fn(),
  messagesCreate: vi.fn(),
  messagesUpdate: vi.fn(),
  recommendationsCreate: vi.fn(),
  activitiesCreate: vi.fn(),
  notificationsFindFirst: vi.fn(),
  notificationsCreate: vi.fn(),
  userFindUnique: vi.fn(),
}))

vi.mock('@/lib/gmail-helpers', () => ({ getGoogleAccessToken: mocks.getGoogleAccessToken }))
vi.mock('./gmail-client', () => ({ fetchRecentGmailMessages: mocks.fetchRecentGmailMessages }))
vi.mock('@/lib/db', () => ({
  db: {
    gmailSyncState: { upsert: mocks.syncStateUpsert, update: mocks.syncStateUpdate },
    job: { findMany: mocks.jobsFindMany, update: mocks.jobsUpdate },
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
  mocks.jobsUpdate.mockResolvedValue({})
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
    expect(mocks.jobsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'applied', workflowState: 'submitted', appliedAt: receivedAt }),
    }))
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
    expect(mocks.jobsUpdate).not.toHaveBeenCalled()
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
