import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ prepareAiRoute: vi.fn(), jobFindFirst: vi.fn(), modelChat: vi.fn() }))

vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))
vi.mock('@/lib/model-router', () => ({ modelChat: mocks.modelChat }))
vi.mock('@/lib/db', () => ({ db: { job: { findFirst: mocks.jobFindFirst }, activity: { create: vi.fn() } } }))

describe('POST /api/gmail/ai-reply', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.prepareAiRoute.mockReset().mockResolvedValue({ userId: 'current-user', cfg: {} })
    mocks.jobFindFirst.mockReset().mockResolvedValue(null)
    mocks.modelChat.mockReset()
  })

  it('does not write an activity against another user job', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/gmail/ai-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Interview', emailBody: 'Please reply', senderName: 'Recruiter', senderEmail: 'recruiter@example.com', tag: 'interview_invitation', jobId: 'other-user-job' }),
    }) as never)

    expect(response?.status).toBe(404)
    expect(mocks.jobFindFirst).toHaveBeenCalledWith({ where: { id: 'other-user-job', userId: 'current-user' }, select: { id: true } })
    expect(mocks.modelChat).not.toHaveBeenCalled()
  })
})
