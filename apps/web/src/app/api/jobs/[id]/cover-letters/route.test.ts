import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  jobFindFirst: vi.fn(),
  resumeFindFirst: vi.fn(),
  coverLetterCreate: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: {
  job: { findFirst: mocks.jobFindFirst },
  resume: { findFirst: mocks.resumeFindFirst },
  coverLetter: { create: mocks.coverLetterCreate },
} }))

describe('POST /api/jobs/[id]/cover-letters ownership', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1' })
    mocks.coverLetterCreate.mockResolvedValue({ id: 'letter_1' })
  })

  it('rejects a resume owned by another account', async () => {
    mocks.resumeFindFirst.mockResolvedValue(null)
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/cover-letters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'foreign-resume' }),
    }), { params: Promise.resolve({ id: 'job_1' }) })

    expect(response.status).toBe(404)
    expect(mocks.coverLetterCreate).not.toHaveBeenCalled()
  })

  it('creates a draft only after validating the resume tenant', async () => {
    mocks.resumeFindFirst.mockResolvedValue({ id: 'resume_1' })
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/cover-letters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_1', content: 'Draft' }),
    }), { params: Promise.resolve({ id: 'job_1' }) })

    expect(response.status).toBe(201)
    expect(mocks.coverLetterCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user_1', jobId: 'job_1', resumeId: 'resume_1' }),
    }))
  })

  it('rejects malformed resume identifiers before any ownership query', async () => {
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/cover-letters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 42 }),
    }), { params: Promise.resolve({ id: 'job_1' }) })

    expect(response.status).toBe(400)
    expect(mocks.resumeFindFirst).not.toHaveBeenCalled()
    expect(mocks.coverLetterCreate).not.toHaveBeenCalled()
  })
})
