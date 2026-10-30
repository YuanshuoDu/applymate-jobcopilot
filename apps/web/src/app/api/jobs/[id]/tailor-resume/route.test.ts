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
  resumeUpdate: vi.fn(),
  resumeVersionCreate: vi.fn(),
  activityCreate: vi.fn(),
  hasEffectiveEntitlement: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock('@/lib/db', () => ({
  db: {
    resume: { findFirst: mocks.resumeFindFirst, create: mocks.resumeCreate, update: mocks.resumeUpdate },
    resumeVersion: { create: mocks.resumeVersionCreate },
    job: { findFirst: mocks.jobFindFirst },
    activity: { create: mocks.activityCreate },
  },
}))

vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  parseAiJson: mocks.parseAiJson,
}))
vi.mock('@/lib/persona', () => ({ buildPersona: mocks.buildPersona }))
vi.mock('@/lib/entitlements', () => ({ hasEffectiveEntitlement: mocks.hasEffectiveEntitlement }))

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
    mocks.resumeUpdate.mockReset()
    mocks.resumeVersionCreate.mockReset()
    mocks.activityCreate.mockReset()
    mocks.hasEffectiveEntitlement.mockReset()
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: { provider: 'test', model: 'm1' } })
    mocks.hasEffectiveEntitlement.mockResolvedValue(true)
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
  }, 15_000)

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

  it.each([
    ['another tailored resume is newest', { id: 'resume_other' }],
    ['no tailored resume exists for the job', null],
  ])('rejects forced repair before any writes or AI when %s', async (_reason, existing) => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_selected' }).mockResolvedValueOnce(existing)
    mocks.jobFindFirst.mockResolvedValueOnce({ id: 'job_1', description: 'Build reliable systems.' })
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_selected', forceRetailor: true }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: expect.stringContaining('Open it to edit') })
    expect(mocks.resumeFindFirst).toHaveBeenNthCalledWith(1, { where: { id: 'resume_selected', userId: 'user_1' } })
    expect(mocks.resumeFindFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { userId: 'user_1', targetJobId: 'job_1', kind: 'adapted', origin: 'ai-adapted' } }))
    expect(mocks.jobFindFirst).toHaveBeenCalledWith({ where: { id: 'job_1', userId: 'user_1' } })
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.buildPersona).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it.each(['resume', 'job'])('rejects forced repair when the account does not own the %s', async missing => {
    mocks.resumeFindFirst.mockResolvedValueOnce(missing === 'resume' ? null : { id: 'resume_selected' }).mockResolvedValueOnce({ id: 'resume_selected' })
    mocks.jobFindFirst.mockResolvedValueOnce(missing === 'job' ? null : { id: 'job_1', description: 'Build reliable systems.' })
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_selected', forceRetailor: true }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(404)
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
  })

  it('repairs only the experience section when the audit flags an unsupported role claim', async () => {
    mocks.resumeFindFirst
      .mockResolvedValueOnce({ id: 'resume_tailored', content: { summary: 'Engineer', experience: [{ role: 'Invented title' }], skills: ['TypeScript'] } })
      .mockResolvedValueOnce({ id: 'resume_tailored', parentResumeId: 'resume_base', content: { summary: 'Engineer', experience: [{ role: 'Invented title' }], skills: ['TypeScript'] }, name: 'Tailored' })
      .mockResolvedValueOnce({ id: 'resume_base', content: { summary: 'Engineer', experience: [{ role: 'Developer' }], skills: ['TypeScript'] } })
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', company: 'N26', role: 'Backend Engineer', description: 'Build reliable systems.', keywords: '' })
    mocks.modelChat.mockResolvedValue({ text: '{"after":[{"role":"Developer"}],"reason":"Removed unsupported title"}' })
    mocks.parseAiJson.mockReturnValue({ after: [{ role: 'Developer' }], reason: 'Removed unsupported title' })
    mocks.resumeVersionCreate.mockResolvedValue({})
    mocks.resumeUpdate.mockResolvedValue({ id: 'resume_tailored' })
    mocks.activityCreate.mockResolvedValue({})
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_tailored', forceRetailor: true, auditFindings: [{ area: 'resume', severity: 'critical', title: 'Unsupported role title', evidence: 'The experience title is not in the source.', action: 'Restore the source role.' }] }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })

    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(200)
    expect(mocks.modelChat).toHaveBeenCalledTimes(1)
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain('SECTION: experience')
    expect(mocks.resumeVersionCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ resumeId: 'resume_tailored', userId: 'user_1' }) }))
    expect(mocks.resumeUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'resume_tailored' } }))
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
  })
})
