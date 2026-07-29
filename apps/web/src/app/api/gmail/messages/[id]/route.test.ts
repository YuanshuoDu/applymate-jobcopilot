import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  messageFindFirst: vi.fn(),
  messageUpdate: vi.fn(),
  jobFindFirst: vi.fn(),
  jobCreate: vi.fn(),
  jobUpdate: vi.fn(),
  activityCreate: vi.fn(),
  statusForGmailMessage: vi.fn(),
  canApplyGmailStatus: vi.fn(),
  activityTypeForGmailMessage: vi.fn(),
  gmailEventLabel: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/db', () => ({
  db: {
    gmailMessage: { findFirst: mocks.messageFindFirst, update: mocks.messageUpdate },
    job: { findFirst: mocks.jobFindFirst, create: mocks.jobCreate, update: mocks.jobUpdate },
    activity: { create: mocks.activityCreate },
  },
}))
vi.mock('@/lib/gmail-tracking/lifecycle', () => ({
  statusForGmailMessage: mocks.statusForGmailMessage,
  canApplyGmailStatus: mocks.canApplyGmailStatus,
  activityTypeForGmailMessage: mocks.activityTypeForGmailMessage,
  gmailEventLabel: mocks.gmailEventLabel,
}))

const params = { params: Promise.resolve({ id: 'message-1' }) }
const receivedAt = new Date('2026-07-29T09:00:00Z')

function patchRequest(body: Record<string, string>) {
  return new Request('http://localhost/api/gmail/messages/message-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/gmail/messages/[id]', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.statusForGmailMessage.mockReturnValue('applied')
    mocks.canApplyGmailStatus.mockReturnValue(true)
    mocks.activityTypeForGmailMessage.mockReturnValue('applied')
    mocks.gmailEventLabel.mockReturnValue('application received')
  })

  it('returns an auth error before loading tracked email evidence', async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const { PATCH } = await import('./route')

    const response = await PATCH(patchRequest({ action: 'link', jobId: 'job-1' }) as never, params)

    expect(response.status).toBe(401)
    expect(mocks.messageFindFirst).not.toHaveBeenCalled()
  })

  it('links an application receipt to an owned job and projects its reliable lifecycle status', async () => {
    mocks.messageFindFirst.mockResolvedValue({
      id: 'message-1',
      jobId: null,
      kind: 'application_received',
      receivedAt,
      subject: 'Application received: Senior Engineer at Acme',
    })
    mocks.jobFindFirst.mockResolvedValue({
      id: 'job-1',
      company: 'Acme',
      role: 'Senior Engineer',
      status: 'saved',
      appliedAt: null,
    })
    mocks.jobUpdate.mockResolvedValue({ id: 'job-1', company: 'Acme', role: 'Senior Engineer', status: 'applied', appliedAt: receivedAt })
    mocks.messageUpdate.mockResolvedValue({ id: 'message-1', jobId: 'job-1', manuallyLinked: true })
    mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
    const { PATCH } = await import('./route')

    const response = await PATCH(patchRequest({ action: 'link', jobId: 'job-1' }) as never, params)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      message: { id: 'message-1', jobId: 'job-1', manuallyLinked: true },
      job: { id: 'job-1', status: 'applied' },
    })
    expect(mocks.jobFindFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: 'applied', workflowState: 'submitted', appliedAt: receivedAt },
    })
    expect(mocks.messageUpdate).toHaveBeenCalledWith({
      where: { id: 'message-1' },
      data: { jobId: 'job-1', matchConfidence: 1, manuallyLinked: true },
    })
  })
})
