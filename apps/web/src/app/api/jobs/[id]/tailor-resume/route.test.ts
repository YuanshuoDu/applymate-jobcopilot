import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  prepareAiRoute: vi.fn(),
  resumeFindFirst: vi.fn(),
  jobFindFirst: vi.fn(),
  modelChat: vi.fn(),
  buildPersona: vi.fn(),
  parseAiJson: vi.fn(),
  resumeCreate: vi.fn(),
  activityCreate: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock('@/lib/db', () => ({
  db: {
    resume: { findFirst: mocks.resumeFindFirst, create: mocks.resumeCreate },
    job: { findFirst: mocks.jobFindFirst },
    activity: { create: mocks.activityCreate },
  },
}))

vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  parseAiJson: mocks.parseAiJson,
}))
vi.mock('@/lib/persona', () => ({ buildPersona: mocks.buildPersona }))

describe('tailor resume API', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.prepareAiRoute.mockReset()
    mocks.resumeFindFirst.mockReset()
    mocks.jobFindFirst.mockReset()
    mocks.modelChat.mockReset()
    mocks.buildPersona.mockReset()
    mocks.parseAiJson.mockReset()
    mocks.resumeCreate.mockReset()
    mocks.activityCreate.mockReset()
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: { provider: 'test', model: 'm1' } })
    mocks.buildPersona.mockResolvedValue('EXPERIENCE:\n- Backend engineer')
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

  it('uses the confirmed Persona as a fact boundary for newly tailored sections', async () => {
    mocks.resumeFindFirst
      .mockResolvedValueOnce({ id: 'resume_base', content: { summary: 'Backend engineer' }, templateId: null, templateOptions: null, directionId: null, basicsDetached: false })
      .mockResolvedValueOnce(null)
    mocks.jobFindFirst.mockResolvedValueOnce({ id: 'job_1', company: 'N26', role: 'Backend Engineer', description: 'Build reliable TypeScript systems.', keywords: 'TypeScript' })
    mocks.modelChat.mockResolvedValue({ text: '{"after":"Backend engineer building TypeScript systems","reason":"Aligned skills"}' })
    mocks.parseAiJson.mockReturnValue({ after: 'Backend engineer building TypeScript systems', reason: 'Aligned skills' })
    mocks.resumeCreate.mockResolvedValue({ id: 'resume_tailored', name: 'Tailored for N26 - Backend Engineer' })
    mocks.activityCreate.mockResolvedValue({})
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', body: JSON.stringify({ resumeId: 'resume_base' }), headers: { 'Content-Type': 'application/json' },
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })

    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(200)
    expect(mocks.modelChat).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('CONFIRMED PERSONA') })]), expect.any(Object), 2000)
  })
})
