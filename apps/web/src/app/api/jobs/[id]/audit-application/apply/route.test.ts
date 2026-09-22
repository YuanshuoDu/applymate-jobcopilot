import { beforeEach, describe, expect, it, vi } from 'vitest'
import { auditActivityText } from '@/lib/application-audit'
import type { ApplicationAudit } from '@/lib/types'

const mocks = {
  jobFindFirst: vi.fn(), resumeFindFirst: vi.fn(), resumeUpdate: vi.fn(),
  resumeVersionCreate: vi.fn(), coverLetterFindFirst: vi.fn(), coverLetterUpdate: vi.fn(),
  activityFindFirst: vi.fn(), activityCreate: vi.fn(), prepareAiRoute: vi.fn(),
  modelChat: vi.fn(), buildPersona: vi.fn(),
}

vi.mock('@/lib/db', () => ({ db: {
  job: { findFirst: mocks.jobFindFirst },
  resume: { findFirst: mocks.resumeFindFirst, update: mocks.resumeUpdate },
  resumeVersion: { create: mocks.resumeVersionCreate, findFirst: vi.fn() },
  coverLetter: { findFirst: mocks.coverLetterFindFirst, update: mocks.coverLetterUpdate },
  activity: { findFirst: mocks.activityFindFirst, create: mocks.activityCreate },
} }))
vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  requireAuth: vi.fn().mockResolvedValue({ userId: 'user_1' }),
  isErrorResponse: () => false,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  parseAiJson: (raw: string) => JSON.parse(raw),
}))
vi.mock('@/lib/persona', () => ({ buildPersona: mocks.buildPersona }))

const resumeContent = {
  contact: { name: 'Ada', email: 'ada@example.com', location: 'Dublin' },
  summary: 'Engineer', experience: [{ company: 'Acme', role: 'Engineer', period: '2021 – Present', bullets: ['Built systems.'] }],
  education: [], skills: ['TypeScript'],
}

function request(body: unknown) {
  return new Request('http://localhost/api/jobs/job_1/audit-application/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

function audit(overrides: Partial<ApplicationAudit> = {}): ApplicationAudit {
  return {
    verdict: 'needs_review', summary: 'Review one claim.', matchScore: 70,
    findings: [{
      area: 'resume', severity: 'warning', resolution: 'evidence_needed', target: 'summary',
      title: 'Unsupported summary', evidence: 'The source does not confirm this wording.', action: 'Use supported wording.',
      proposedValue: 'Supported summary.',
    }],
    source: 'parent_resume', auditedAt: '2026-09-22T10:00:00.000Z', ...overrides,
  }
}

describe('POST /api/jobs/[id]/audit-application/apply', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.jobFindFirst.mockResolvedValue({ role: 'Engineer', company: 'Acme', description: 'Build TypeScript systems.' })
    mocks.resumeFindFirst.mockResolvedValue({ id: 'resume_final', userId: 'user_1', name: 'Final', parentResumeId: 'resume_base', updatedAt: new Date('2026-09-22T10:01:00.000Z'), content: resumeContent })
    mocks.resumeUpdate.mockResolvedValue({ id: 'resume_final', name: 'Final', updatedAt: new Date('2026-09-22T10:02:00.000Z'), content: { ...resumeContent, summary: 'Supported summary.' } })
    mocks.resumeVersionCreate.mockResolvedValue({ id: 'version_1' })
    mocks.coverLetterFindFirst.mockResolvedValue(null)
    mocks.coverLetterUpdate.mockResolvedValue(null)
    mocks.activityCreate.mockResolvedValue({ id: 'activity_2' })
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: { provider: 'minimax', model: 'MiniMax-M3', thinking: 'disabled' } })
    mocks.buildPersona.mockResolvedValue('CONFIRMED PERSONA')
  })

  it('applies a generated resume section, snapshots the old version, and marks the finding applied', async () => {
    const storedAudit = audit()
    mocks.activityFindFirst.mockResolvedValue({ text: auditActivityText('resume_final', null, storedAudit, { resumeUpdatedAt: '2026-09-22T10:01:00.000Z' }) })
    const { POST } = await import('./route')

    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: null, findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.audit.findings[0]).toMatchObject({ applied: true, target: 'summary', proposedValue: 'Supported summary.' })
    expect(mocks.resumeVersionCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ resumeId: 'resume_final', content: resumeContent }) }))
    expect(mocks.resumeUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { content: { ...resumeContent, summary: 'Supported summary.' } } }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ text: expect.stringContaining('"applied":true') }) }))
  })

  it('applies a cover-letter correction without changing the resume', async () => {
    const storedAudit = audit({ findings: [{
      area: 'cover_letter', severity: 'warning', resolution: 'evidence_needed', target: 'cover_letter',
      title: 'Unsupported letter claim', evidence: 'The source does not confirm this claim.', action: 'Remove it.',
      proposedValue: 'Dear Acme, I bring supported delivery experience.',
    }] })
    mocks.activityFindFirst.mockResolvedValue({ text: auditActivityText('resume_final', 'cover_1', storedAudit, {
      resumeUpdatedAt: '2026-09-22T10:01:00.000Z', coverLetterUpdatedAt: '2026-09-22T10:01:30.000Z',
    }) })
    mocks.coverLetterFindFirst.mockResolvedValue({ id: 'cover_1', content: 'Old letter', updatedAt: new Date('2026-09-22T10:01:30.000Z') })
    mocks.coverLetterUpdate.mockResolvedValue({ id: 'cover_1', content: 'Dear Acme, I bring supported delivery experience.', updatedAt: new Date('2026-09-22T10:03:00.000Z') })
    const { POST } = await import('./route')

    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1', findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.audit.findings[0].applied).toBe(true)
    expect(mocks.coverLetterUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { content: 'Dear Acme, I bring supported delivery experience.' } }))
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
  })

  it('rejects an audit finding when the audited resume has changed', async () => {
    const storedAudit = audit()
    mocks.activityFindFirst.mockResolvedValue({ text: auditActivityText('resume_final', null, storedAudit, { resumeUpdatedAt: '2026-09-22T09:00:00.000Z' }) })
    const { POST } = await import('./route')

    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: null, findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!

    expect(response.status).toBe(409)
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
  })

  it('generates a safe replacement when the audit did not provide one', async () => {
    const storedAudit = audit({ findings: [{
      area: 'resume', severity: 'warning', resolution: 'evidence_needed', target: 'summary',
      title: 'Unsupported summary', evidence: 'The source does not confirm this wording.', action: 'Use supported wording.',
    }] })
    mocks.activityFindFirst.mockResolvedValue({ text: auditActivityText('resume_final', null, storedAudit, { resumeUpdatedAt: '2026-09-22T10:01:00.000Z' }) })
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ proposedValue: 'Generated supported summary.' }) })
    const { POST } = await import('./route')

    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: null, findingIndex: 0 }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.appliedContent).toBe('Generated supported summary.')
    expect(mocks.modelChat).toHaveBeenCalled()
    expect(mocks.buildPersona).toHaveBeenCalledWith('user_1', 'tailor')
  })
})
