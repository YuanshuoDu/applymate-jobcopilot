import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  prepareAiRoute: vi.fn(),
  jobFindFirst: vi.fn(),
  resumeFindFirst: vi.fn(),
  agentRoleFindFirst: vi.fn(),
  coverLetterCreate: vi.fn(),
  modelChat: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: {
  job: { findFirst: mocks.jobFindFirst },
  resume: { findFirst: mocks.resumeFindFirst },
  agentRole: { findFirst: mocks.agentRoleFindFirst },
  coverLetter: { create: mocks.coverLetterCreate },
} }))
vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  stripFences: (text: string) => text,
}))

describe('cover letter generation after an audit failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: { provider: 'minimax', model: 'MiniMax-M2.7' } })
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', role: 'Engineer', company: 'Acme', description: 'Build resilient systems.', finalResumeId: null })
    mocks.resumeFindFirst.mockResolvedValue({ id: 'resume_1', content: { contact: { name: 'Ada' }, summary: 'Engineer', experience: [], skills: ['TypeScript'] }, templateId: 'clean', templateOptions: null })
    mocks.agentRoleFindFirst.mockResolvedValue(null)
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M2.7', text: 'Dear Hiring Manager,\n\nThank you.\n\nSincerely,\nAda' })
    mocks.coverLetterCreate.mockResolvedValue({ id: 'letter_2', resumeId: 'resume_1' })
  })

  it('passes failed-audit correction instructions into the Writer prompt', async () => {
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/cover-letters/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resumeId: 'resume_1', preferProvidedResume: true,
        auditFindings: [{ area: 'cover_letter', severity: 'critical', title: 'Unsupported metric', evidence: '50% is absent from the source.', action: 'Remove the metric or cite supported evidence.' }],
      }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })

    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(201)
    expect(mocks.modelChat.mock.calls[0][0][1].content).toContain('AUDIT REPAIR NOTES')
    expect(mocks.modelChat.mock.calls[0][0][1].content).toContain('Remove the metric or cite supported evidence.')
  })
})
