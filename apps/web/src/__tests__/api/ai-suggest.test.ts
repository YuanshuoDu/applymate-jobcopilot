/**
 * AI suggestions route tests.
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
  prepareAiRoute: vi.fn().mockResolvedValue({ auth: { userId: 'test-user' }, cfg: { provider: 'anthropic', model: 'claude-sonnet-4-6' } }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ ok: true }),
}))

function fakeNextRequest(body: unknown): Request {
  return new Request('http://localhost/api/ai/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/ai/suggest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when resumeContent is missing', async () => {
    const { POST } = await import('@/app/api/ai/suggest/route')
    const req = fakeNextRequest({ jobTitle: 'Engineer' })
    const res = await POST(req as never)
    expect(res!.status).toBe(400)
  })

  it('returns 3 suggestions from a successful AI response', async () => {
    const { POST } = await import('@/app/api/ai/suggest/route')

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify([
        'Add Docker and Kubernetes to your skills section',
        'Quantify your experience with numbers and metrics',
        'Tailor your summary to mention cloud-native development',
      ]) }],
    })

    const req = fakeNextRequest({
      resumeContent: { summary: 'Dev', skills: ['js'], experience: [] },
      jobTitle: 'Cloud Engineer',
    })
    const res = await POST(req as never)

    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(body.suggestions).toHaveLength(3)
    expect(body.suggestions[0].text).toContain('Docker')
    expect(body.suggestions[0].applied).toBe(false)
  })

  it('handles markdown-wrapped JSON responses', async () => {
    const { POST } = await import('@/app/api/ai/suggest/route')

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n["Suggestion one", "Suggestion two", "Suggestion three"]\n```' }],
    })

    const req = fakeNextRequest({
      resumeContent: { summary: 'test' },
    })
    const res = await POST(req as never)

    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(body.suggestions).toHaveLength(3)
  })
})
