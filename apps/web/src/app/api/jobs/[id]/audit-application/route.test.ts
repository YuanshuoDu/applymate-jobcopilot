import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = {
  jobFindFirst: vi.fn(), resumeFindFirst: vi.fn(), coverLetterFindFirst: vi.fn(),
  resumeVersionFindFirst: vi.fn(), agentRoleFindFirst: vi.fn(), modelChat: vi.fn(),
  activityCreate: vi.fn(), activityFindFirst: vi.fn(),
}

vi.mock('@/lib/db', () => ({ db: {
  job: { findFirst: mocks.jobFindFirst },
  resume: { findFirst: mocks.resumeFindFirst },
  coverLetter: { findFirst: mocks.coverLetterFindFirst },
  resumeVersion: { findFirst: mocks.resumeVersionFindFirst },
  agentRole: { findFirst: mocks.agentRoleFindFirst },
  activity: { create: mocks.activityCreate, findFirst: mocks.activityFindFirst },
} }))
vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: vi.fn().mockResolvedValue({ userId: 'user_1', cfg: { provider: 'minimax', model: 'MiniMax-M2.7' } }),
  requireAuth: vi.fn().mockResolvedValue({ userId: 'user_1' }),
  isErrorResponse: () => false,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  parseAiJson: (raw: string) => JSON.parse(raw),
}))

function request(body: unknown) {
  return new Request('http://localhost/api/jobs/job_1/audit-application', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('POST /api/jobs/[id]/audit-application', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', company: 'Acme', role: 'Engineer', description: 'Build TypeScript systems.' })
    mocks.resumeFindFirst.mockResolvedValue({ id: 'resume_final', parentResumeId: 'resume_base', content: { contact: { name: 'Ada', email: 'ada@example.com', location: 'Dublin' }, summary: 'Engineer', experience: [], education: [], skills: ['TypeScript'] } })
    mocks.coverLetterFindFirst.mockResolvedValue({ content: 'Dear Acme, I built TypeScript systems.' })
    mocks.agentRoleFindFirst.mockResolvedValue(null)
    mocks.activityCreate.mockResolvedValue({ id: 'activity_1' })
  })

  it('audits final material against the tailored resume parent', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: 'resume_base', content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] } })
      .mockResolvedValueOnce({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M2.7', text: JSON.stringify({ verdict: 'pass', matchScore: 82, summary: 'Supported and relevant.', findings: [
      { area: 'resume', severity: 'pass', title: 'Supported facts', evidence: 'Matches source.', action: 'None.' },
      { area: 'cover_letter', severity: 'pass', title: 'Supported letter', evidence: 'Uses source experience.', action: 'None.' },
      { area: 'job_match', severity: 'pass', title: 'Relevant match', evidence: 'TypeScript is required.', action: 'None.' },
    ] }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.source).toBe('parent_resume')
    expect(body.verdict).toBe('pass')
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain('SOURCE RESUME')
    expect(mocks.activityCreate.mock.calls[0][0].data.text).toContain('[Auditor] application-audit')
  })

  it('blocks confirmation when the independent auditor finds an unsupported concrete claim', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: null, content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] } })
    mocks.resumeVersionFindFirst.mockResolvedValue({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M2.7', text: JSON.stringify({ verdict: 'pass', findings: [{ area: 'cover_letter', severity: 'critical', title: 'Unsupported metric', evidence: 'Claims 50% growth absent from source.', action: 'Remove or substantiate it.' }] }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()
    expect(body.source).toBe('previous_version')
    expect(body.verdict).toBe('blocked')
  })

  it('refuses to pass when no source resume exists for an independent comparison', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: null, content: { contact: {}, summary: 'Only version', experience: [], education: [], skills: [] } })
    mocks.resumeVersionFindFirst.mockResolvedValue(null)
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(mocks.modelChat).not.toHaveBeenCalled()
  })

  it('returns the latest persisted audit so each surface uses the same version', async () => {
    mocks.activityFindFirst.mockResolvedValue({ text: '[Auditor] application-audit {"resumeId":"resume_final","coverLetterId":"cover_1","audit":{"verdict":"needs_review","summary":"Revise wording.","matchScore":72,"findings":[]}}' })
    const { GET } = await import('./route')
    const response = (await GET(new Request('http://localhost/api/jobs/job_1/audit-application') as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    await expect(response.json()).resolves.toMatchObject({ resumeId: 'resume_final', coverLetterId: 'cover_1', audit: { verdict: 'needs_review' } })
    expect(mocks.activityFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ jobId: 'job_1' }) }))
  })
})
