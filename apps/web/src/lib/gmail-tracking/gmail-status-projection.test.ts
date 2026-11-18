import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GmailMatchableJob } from './matching'
import type { GmailTrackedMessageData } from './gmail-status-projection'

const mocks = vi.hoisted(() => {
  const state = {
    order: [] as string[],
    transaction: vi.fn(),
    jobFindFirst: vi.fn(),
    jobUpdateMany: vi.fn(),
    acquireFence: vi.fn(),
    trackedMessageCreate: vi.fn(),
    activityCreate: vi.fn(),
    notificationCreate: vi.fn(),
    purgeCoverLetters: vi.fn(),
  }
  state.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
    state.order.push('transaction:start')
    try {
      const result = await callback({
        job: { findFirst: state.jobFindFirst, updateMany: state.jobUpdateMany },
        gmailMessage: { create: state.trackedMessageCreate },
      })
      state.order.push('transaction:commit')
      return result
    } catch (error) {
      state.order.push('transaction:rollback')
      throw error
    }
  })
  return state
})

vi.mock('@/lib/agent/source-material-fence', () => ({
  acquireSourceMaterialFence: mocks.acquireFence,
}))
vi.mock('@/lib/cover-letter-retention', () => ({
  purgeTemporaryGeneratedCoverLetters: mocks.purgeCoverLetters,
}))
vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    job: { findFirst: mocks.jobFindFirst, updateMany: mocks.jobUpdateMany },
    gmailMessage: { create: mocks.trackedMessageCreate },
    activity: { create: mocks.activityCreate },
    notification: { create: mocks.notificationCreate },
  },
}))

import { recordLinkedGmailEvent, trackAndProjectLinkedStatusMessage } from './gmail-status-projection'

const receivedAt = new Date('2026-07-29T09:00:00Z')
const jobSnapshot: GmailMatchableJob = {
  id: 'job-1', company: 'Acme Labs', role: 'Senior Data Engineer', status: 'saved',
}
const notificationPreferences = {
  apply: true, reject: true, interview: true, offer: true, weekly: true, followUp: true,
}
const trackedMessage: GmailTrackedMessageData = {
  userId: 'user-1',
  gmailMessageId: 'gmail-1',
  gmailThreadId: 'thread-1',
  kind: 'application_received',
  senderEmail: 'talent@acme.example',
  senderName: 'Acme Talent',
  subject: 'Application received: Senior Data Engineer at Acme Labs',
  excerpt: 'Thank you for applying',
  inferredCompany: 'Acme Labs',
  inferredRole: 'Senior Data Engineer',
  receivedAt,
  scheduledAt: null,
  jobId: 'job-1',
  matchConfidence: 1,
  processedAt: receivedAt,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.order.length = 0
  mocks.acquireFence.mockImplementation(async (_tx: unknown, userIds: readonly string[]) => {
    mocks.order.push('fence:' + userIds.join(','))
  })
  mocks.jobFindFirst.mockImplementation(async () => {
    mocks.order.push('job:read')
    return {
      id: 'job-1', company: 'Acme Labs', role: 'Senior Data Engineer',
      status: 'saved', workflowState: 'ready_to_apply', appliedAt: null,
    }
  })
  mocks.jobUpdateMany.mockImplementation(async () => {
    mocks.order.push('job:update')
    return { count: 1 }
  })
  mocks.trackedMessageCreate.mockImplementation(async () => {
    mocks.order.push('tracked-message:create')
    return { id: 'tracked-1' }
  })
  mocks.activityCreate.mockImplementation(async () => { mocks.order.push('activity'); return {} })
  mocks.notificationCreate.mockImplementation(async () => { mocks.order.push('notification'); return {} })
  mocks.purgeCoverLetters.mockImplementation(async () => { mocks.order.push('purge'); return 0 })
})

describe('trackAndProjectLinkedStatusMessage', () => {
  it('fences first, then reads, CAS-updates, and inserts the dedupe row before commit', async () => {
    const staleSnapshot = { ...jobSnapshot, status: 'rejected' as const }

    await expect(trackAndProjectLinkedStatusMessage(
      'user-1', staleSnapshot, receivedAt, 'application_received', notificationPreferences, trackedMessage,
    )).resolves.toEqual({ kind: 'tracked', statusUpdated: true })

    expect(mocks.order).toEqual([
      'transaction:start', 'fence:user-1', 'job:read', 'job:update', 'tracked-message:create',
      'transaction:commit', 'purge', 'activity', 'notification',
    ])
    expect(mocks.jobFindFirst).toHaveBeenCalledWith({
      where: { id: 'job-1', userId: 'user-1' },
      select: { id: true, company: true, role: true, status: true, workflowState: true, appliedAt: true },
    })
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1', userId: 'user-1', status: 'saved',
        workflowState: 'ready_to_apply', appliedAt: null,
      },
      data: { status: 'applied', workflowState: 'submitted', appliedAt: receivedAt },
    })
    expect(mocks.trackedMessageCreate).toHaveBeenCalledWith({ data: trackedMessage })
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'user-1', jobId: 'job-1',
        text: 'Gmail application receipt from Acme Labs for Senior Data Engineer — status updated to applied',
      }),
    }))
    expect(mocks.purgeCoverLetters).toHaveBeenCalledWith('user-1', 'job-1')
  })

  it('tracks an ineligible event and records activity without changing the fresh status', async () => {
    mocks.jobFindFirst.mockResolvedValue({
      id: 'job-1', company: 'Acme Labs', role: 'Senior Data Engineer',
      status: 'interview', workflowState: 'submitted', appliedAt: receivedAt,
    })

    await expect(trackAndProjectLinkedStatusMessage(
      'user-1', jobSnapshot, receivedAt, 'application_received', notificationPreferences, trackedMessage,
    )).resolves.toEqual({ kind: 'tracked', statusUpdated: false })

    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
    expect(mocks.trackedMessageCreate).toHaveBeenCalledOnce()
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ text: 'Gmail application receipt from Acme Labs for Senior Data Engineer' }),
    }))
    expect(mocks.notificationCreate).not.toHaveBeenCalled()
    expect(mocks.purgeCoverLetters).not.toHaveBeenCalled()
  })

  it('rolls back and leaves the message retryable when status CAS loses', async () => {
    mocks.jobUpdateMany.mockImplementation(async () => {
      mocks.order.push('job:update')
      return { count: 0 }
    })

    await expect(trackAndProjectLinkedStatusMessage(
      'user-1', jobSnapshot, receivedAt, 'application_received', notificationPreferences, trackedMessage,
    )).resolves.toEqual({ kind: 'retry', reason: 'cas_miss' })

    expect(mocks.order).toEqual(['transaction:start', 'fence:user-1', 'job:read', 'job:update', 'transaction:rollback'])
    expect(mocks.trackedMessageCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.notificationCreate).not.toHaveBeenCalled()
    expect(mocks.purgeCoverLetters).not.toHaveBeenCalled()
  })

  it('rolls back on a unique dedupe conflict and performs no post-commit effects', async () => {
    mocks.trackedMessageCreate.mockImplementationOnce(async () => {
      mocks.order.push('tracked-message:create')
      throw { code: 'P2002' }
    })

    await expect(trackAndProjectLinkedStatusMessage(
      'user-1', jobSnapshot, receivedAt, 'application_received', notificationPreferences, trackedMessage,
    )).resolves.toEqual({ kind: 'duplicate' })

    expect(mocks.order).toEqual([
      'transaction:start', 'fence:user-1', 'job:read', 'job:update', 'tracked-message:create', 'transaction:rollback',
    ])
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.notificationCreate).not.toHaveBeenCalled()
    expect(mocks.purgeCoverLetters).not.toHaveBeenCalled()
  })

  it('allows a full retry after fence failure leaves no tracked row', async () => {
    mocks.acquireFence.mockRejectedValueOnce(new Error('fence unavailable'))

    await expect(trackAndProjectLinkedStatusMessage(
      'user-1', jobSnapshot, receivedAt, 'application_received', notificationPreferences, trackedMessage,
    )).resolves.toEqual({ kind: 'retry', reason: 'transaction_error' })
    expect(mocks.trackedMessageCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()

    await expect(trackAndProjectLinkedStatusMessage(
      'user-1', jobSnapshot, receivedAt, 'application_received', notificationPreferences, trackedMessage,
    )).resolves.toEqual({ kind: 'tracked', statusUpdated: true })
    expect(mocks.trackedMessageCreate).toHaveBeenCalledOnce()
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
  })

  it('suppresses post-commit side effects when transaction outcome is unknown', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('connection lost while committing'))

    await expect(trackAndProjectLinkedStatusMessage(
      'user-1', jobSnapshot, receivedAt, 'application_received', notificationPreferences, trackedMessage,
    )).resolves.toEqual({ kind: 'retry', reason: 'transaction_error' })

    expect(mocks.purgeCoverLetters).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.notificationCreate).not.toHaveBeenCalled()
  })

  it('does not link a missing or foreign scoped Job or run Job side effects', async () => {
    mocks.jobFindFirst.mockResolvedValue(null)

    await expect(trackAndProjectLinkedStatusMessage(
      'user-1', jobSnapshot, receivedAt, 'interview_invitation', notificationPreferences,
      { ...trackedMessage, kind: 'interview_invitation' },
    )).resolves.toEqual({ kind: 'tracked', statusUpdated: false })

    expect(mocks.jobFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'job-1', userId: 'user-1' } }))
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
    expect(mocks.trackedMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', jobId: null, matchConfidence: null }),
    })
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.notificationCreate).not.toHaveBeenCalled()
    expect(mocks.purgeCoverLetters).not.toHaveBeenCalled()
  })

  it('stops before Job access, dedupe insertion, and side effects when fence acquisition fails', async () => {
    mocks.acquireFence.mockRejectedValue(new Error('fence unavailable'))

    await expect(trackAndProjectLinkedStatusMessage(
      'user-1', jobSnapshot, receivedAt, 'offer', notificationPreferences,
      { ...trackedMessage, kind: 'offer' },
    )).resolves.toEqual({ kind: 'retry', reason: 'transaction_error' })

    expect(mocks.jobFindFirst).not.toHaveBeenCalled()
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
    expect(mocks.trackedMessageCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.notificationCreate).not.toHaveBeenCalled()
  })

  it('honours status notification preferences after the transaction commits', async () => {
    const preferences = { ...notificationPreferences, interview: false }

    await expect(trackAndProjectLinkedStatusMessage(
      'user-1', jobSnapshot, receivedAt, 'interview_invitation', preferences,
      { ...trackedMessage, kind: 'interview_invitation' },
    )).resolves.toEqual({ kind: 'tracked', statusUpdated: true })

    expect(mocks.order).toContain('transaction:commit')
    expect(mocks.order.indexOf('activity')).toBeGreaterThan(mocks.order.indexOf('transaction:commit'))
    expect(mocks.notificationCreate).not.toHaveBeenCalled()
    expect(mocks.purgeCoverLetters).not.toHaveBeenCalled()
  })
})

describe('recordLinkedGmailEvent', () => {
  it('records non-status event activity without opening a Job projection transaction', async () => {
    await recordLinkedGmailEvent('user-1', jobSnapshot, 'application_update')

    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.acquireFence).not.toHaveBeenCalled()
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
  })

  it('rejects status-bearing kinds so callers cannot bypass atomic deduplication', async () => {
    await expect(recordLinkedGmailEvent('user-1', jobSnapshot, 'application_received')).rejects.toThrow(
      'Status-bearing Gmail messages must use the atomic projection',
    )
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })
})
