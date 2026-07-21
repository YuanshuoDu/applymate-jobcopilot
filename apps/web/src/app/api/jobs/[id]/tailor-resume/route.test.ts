import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  prepareAiRoute: vi.fn(),
  resumeFindFirst: vi.fn(),
  jobFindFirst: vi.fn(),
  modelChat: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock('@/lib/db', () => ({
  db: {
    resume: { findFirst: mocks.resumeFindFirst, create: vi.fn() },
    job: { findFirst: mocks.jobFindFirst },
    activity: { create: vi.fn() },
  },
}))

vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  parseAiJson: vi.fn(),
}))

describe('tailor resume API', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.prepareAiRoute.mockReset()
    mocks.resumeFindFirst.mockReset()
    mocks.jobFindFirst.mockReset()
    mocks.modelChat.mockReset()
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: { provider: 'test', model: 'm1' } })
  })

  it('reuses the tailored resume already linked to the job without calling the AI', async () => {
    mocks.resumeFindFirst
      .mockResolvedValueOnce({ id: 'resume_base' })
      .mockResolvedValueOnce({ id: 'resume_tailored' })
    mocks.jobFindFirst.mockResolvedValueOnce({ id: 'job_1', description: 'Build reliable systems.' })
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', body: JSON.stringify({ resumeId: 'resume_base' }), headers: { 'Content-Type': 'application/json' },
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })

    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ adaptedResumeId: 'resume_tailored', changes: [], reused: true })
    expect(mocks.resumeFindFirst).toHaveBeenLastCalledWith({
      where: { userId: 'user_1', targetJobId: 'job_1', kind: 'adapted', origin: 'ai-adapted' },
      orderBy: { updatedAt: 'desc' }, select: { id: true, parentResumeId: true, content: true, name: true },
    })
    expect(mocks.modelChat).not.toHaveBeenCalled()
  })
})
