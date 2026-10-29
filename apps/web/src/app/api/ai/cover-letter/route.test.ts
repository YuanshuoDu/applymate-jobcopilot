import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  prepareAiRoute: vi.fn(),
  agentRoleFindFirst: vi.fn(),
  jobFindFirst: vi.fn(),
  resumeFindFirst: vi.fn(),
  coverLetterCreate: vi.fn(),
  modelChat: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: {
  agentRole: { findFirst: mocks.agentRoleFindFirst },
  job: { findFirst: mocks.jobFindFirst },
  resume: { findFirst: mocks.resumeFindFirst },
  coverLetter: { create: mocks.coverLetterCreate },
} }))
vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  stripFences: (text: string) => text,
  withMiniMaxThinking: (config: unknown) => config,
}))
vi.mock('@/lib/agent/role-config', () => ({
  roleAiConfig: (_role: string, _roleConfig: unknown, fallback: unknown) => fallback,
}))

function request(body: unknown) {
  return new NextRequest('http://localhost/api/ai/cover-letter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('generic cover-letter persistence ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: { provider: 'minimax', model: 'MiniMax-M3' } })
    mocks.agentRoleFindFirst.mockResolvedValue(null)
    mocks.modelChat.mockResolvedValue({ text: 'Dear Hiring Manager,\n\nThank you.\n\nSincerely,' })
    mocks.coverLetterCreate.mockResolvedValue({ id: 'letter_1' })
  })

  it('rejects a foreign job before persisting generated content', async () => {
    mocks.jobFindFirst.mockResolvedValue(null)
    const { POST } = await import('./route')

    const response = await POST(request({
      resumeContent: { contact: { name: 'Ada' } },
      jobTitle: 'Engineer',
      jobCompany: 'Acme',
      jobId: 'foreign-job',
    }))

    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(404)
    expect(mocks.coverLetterCreate).not.toHaveBeenCalled()
  })

  it('rejects a foreign resume before persisting generated content', async () => {
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1' })
    mocks.resumeFindFirst.mockResolvedValue(null)
    const { POST } = await import('./route')

    const response = await POST(request({
      resumeContent: { contact: { name: 'Ada' } },
      jobTitle: 'Engineer',
      jobCompany: 'Acme',
      jobId: 'job_1',
      resumeId: 'foreign-resume',
    }))

    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(404)
    expect(mocks.coverLetterCreate).not.toHaveBeenCalled()
  })

  it('persists only tenant-owned IDs', async () => {
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1' })
    mocks.resumeFindFirst.mockResolvedValue({ id: 'resume_1' })
    const { POST } = await import('./route')

    const response = await POST(request({
      resumeContent: { contact: { name: 'Ada' } },
      jobTitle: 'Engineer',
      jobCompany: 'Acme',
      jobId: ' job_1 ',
      resumeId: ' resume_1 ',
    }))

    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(200)
    expect(mocks.coverLetterCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user_1', jobId: 'job_1', resumeId: 'resume_1' }),
    }))
  })

  it('attributes every fallback attempt to the owner without passing the primary credential or changing credits', async () => {
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: {
      provider: 'openai', model: 'gpt-4o', apiKey: 'primary-provider-secret',
      usageUserId: 'user_1', usageFeatureKey: 'coverLetter', usageRuntime: 'web',
    } })
    mocks.modelChat.mockRejectedValueOnce(new Error('primary failed')).mockRejectedValueOnce(new Error('fallback failed'))
      .mockResolvedValueOnce({ text: 'Dear Hiring Manager,\n\nThank you.\n\nSincerely,' })
    const { POST } = await import('./route')
    const response = await POST(request({ resumeContent: { contact: { name: 'Ada' } }, jobTitle: 'Engineer', jobCompany: 'Acme' }))

    expect(response?.status).toBe(200)
    expect(mocks.modelChat).toHaveBeenCalledTimes(3)
    expect(mocks.modelChat.mock.calls[0]).toHaveLength(3)
    for (const [index, provider] of [[1, 'deepseek'], [2, 'minimax']] as const) {
      const [, config, , usage] = mocks.modelChat.mock.calls[index]
      expect(config).toMatchObject({ provider })
      expect(config).not.toHaveProperty('apiKey')
      expect(usage).toEqual({ userId: 'user_1', featureKey: 'coverLetter', runtime: 'web', chargeBudget: false })
    }
  })
})
