import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  jobFindMany: vi.fn(),
  notificationCreate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: {
  user: { findMany: mocks.userFindMany },
  job: { findMany: mocks.jobFindMany },
  notification: { create: mocks.notificationCreate },
} }))
vi.mock('@/lib/api-helpers', () => ({
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

function request(secret = 'cron-secret') {
  return new Request('http://localhost/api/notifications/daily', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
  })
}

describe('POST /api/notifications/daily', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.userFindMany.mockReset()
    mocks.jobFindMany.mockReset()
    mocks.notificationCreate.mockReset()
    process.env.NOTIFICATIONS_CRON_SECRET = 'cron-secret'
    process.env.RESEND_API_KEY = ''
    mocks.userFindMany.mockResolvedValue([
      { id: 'user_1', email: 'candidate@example.com', name: 'Candidate', preferences: { notificationPreferences: { weekly: true, followUp: true } } },
    ])
    mocks.jobFindMany.mockResolvedValue([
      { id: 'job_1', userId: 'user_1', company: 'Acme', role: 'Engineer', status: 'applied', followUpAt: new Date(Date.now() - 86_400_000), updatedAt: new Date(), appliedAt: new Date() },
    ])
    mocks.notificationCreate.mockResolvedValue({ id: 'notification_1' })
  })

  it('rejects requests without the scheduled-task secret', async () => {
    const { POST } = await import('./route')
    const response = await POST(request('wrong') as never)
    expect(response.status).toBe(401)
    expect(mocks.notificationCreate).not.toHaveBeenCalled()
  })

  it('creates stable follow-up and weekly notifications', async () => {
    const { POST } = await import('./route')
    const response = await POST(request() as never)
    expect(response.status).toBe(200)
    expect(mocks.notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ id: expect.stringContaining('daily:follow-up:user_1:job_1') }),
    }))
  })
})
