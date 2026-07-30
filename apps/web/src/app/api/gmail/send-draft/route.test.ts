import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getGoogleAccessToken: vi.fn(),
  gmailMessageFindFirst: vi.fn(),
  jobUpdate: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/gmail-helpers', () => ({ getGoogleAccessToken: mocks.getGoogleAccessToken }))
vi.mock('@/lib/db', () => ({
  db: {
    gmailMessage: { findFirst: mocks.gmailMessageFindFirst },
    job: { findFirst: vi.fn(), update: mocks.jobUpdate },
    activity: { create: mocks.activityCreate },
    $transaction: mocks.transaction,
  },
}))

describe('POST /api/gmail/send-draft', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.getGoogleAccessToken.mockResolvedValue('gmail-token')
    mocks.gmailMessageFindFirst.mockResolvedValue({ job: { id: 'job-1' } })
    mocks.jobUpdate.mockResolvedValue({})
    mocks.activityCreate.mockResolvedValue({})
    mocks.transaction.mockResolvedValue([])
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ emailAddress: 'me@example.com' }))
      .mockResolvedValueOnce(Response.json({ id: 'sent-1' })))
  })

  it('sends a threaded follow-up and clears the matched job follow-up task', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/gmail/send-draft', {
      method: 'POST', body: JSON.stringify({ to: 'recruiter@example.com', subject: 'Re: Interview', draft: 'Thank you.', gmailMessageId: 'gmail-1', threadId: 'thread-1', messageKind: 'interview_invitation' }),
    }) as never)

    await expect(response.json()).resolves.toMatchObject({ sent: true, tracked: true, jobId: 'job-1' })
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', expect.objectContaining({ body: expect.stringContaining('"threadId":"thread-1"') }))
    expect(mocks.jobUpdate).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { followUpAt: null } })
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ jobId: 'job-1', type: 'email_sent' }) }))
  })
})
