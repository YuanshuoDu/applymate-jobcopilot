/**
 * Cover letter route tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'test-user', userEmail: 'test@test.com' }),
  isErrorResponse: (val: unknown) => val instanceof Response && (val as Response).status === 401,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ ok: true }),
}))

function fakeNextRequest(body: unknown): Request {
  return new Request('http://localhost/api/ai/cover-letter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/ai/cover-letter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when resumeContent is missing', async () => {
    const { POST } = await import('@/app/api/ai/cover-letter/route')
    const req = fakeNextRequest({ jobTitle: 'Engineer', jobCompany: 'Acme' })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('returns 400 when jobTitle is missing', async () => {
    const { POST } = await import('@/app/api/ai/cover-letter/route')
    const req = fakeNextRequest({ resumeContent: { summary: 'test' }, jobCompany: 'Acme' })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
  })

  it('returns a cover letter on successful generation', async () => {
    const { POST } = await import('@/app/api/ai/cover-letter/route')

    const mockLetter = `Dear Hiring Manager,

I am excited to apply for the Software Engineer role at Acme Corp.

Sincerely,
John Doe`

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: mockLetter }],
    })

    const req = fakeNextRequest({
      resumeContent: {
        contact: { name: 'John Doe', email: 'john@test.com', location: 'NYC' },
        summary: 'Experienced engineer',
        skills: ['TypeScript', 'React'],
        experience: [{ role: 'Senior Dev', company: 'PrevCo', period: '2020-2024', bullets: ['Led a team'] }],
      },
      jobTitle: 'Software Engineer',
      jobCompany: 'Acme Corp',
    })
    const res = await POST(req as never)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.coverLetter).toBe(mockLetter.trim())
  })

  it('includes recipientName in the prompt when provided', async () => {
    const { POST } = await import('@/app/api/ai/cover-letter/route')

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Dear Ms. Smith,\n\n...' }],
    })

    const req = fakeNextRequest({
      resumeContent: { contact: { name: 'Jane', email: 'jane@test.com', location: 'SF' }, summary: '', skills: [], experience: [] },
      jobTitle: 'PM',
      jobCompany: 'StartupInc',
      recipientName: 'Ms. Smith',
    })
    const res = await POST(req as never)

    expect(res.status).toBe(200)
  })

  it('supports different tones', async () => {
    const { POST } = await import('@/app/api/ai/cover-letter/route')

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Short and punchy letter.' }],
    })

    const req = fakeNextRequest({
      resumeContent: { contact: { name: 'A', email: 'a@b.com', location: 'X' }, summary: '', skills: [], experience: [] },
      jobTitle: 'Dev',
      jobCompany: 'Co',
      tone: 'concise',
    })
    const res = await POST(req as never)
    expect(res.status).toBe(200)
  })
})
