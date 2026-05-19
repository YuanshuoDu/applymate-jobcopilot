/**
 * AI suggestions route tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate }
  },
}))

vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: vi.fn().mockResolvedValue({
    userId: 'test-user',
    cfg: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'test-key' },
  }),
  requireAuth: vi.fn().mockResolvedValue({ userId: 'test-user', userEmail: 'test@test.com' }),
  isErrorResponse: (val: unknown) => val instanceof Response && (val as Response).status === 401,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
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
    expect(res.status).toBe(400)
  })

  it('returns 3 suggestions from a successful AI response', async () => {
    const { POST } = await import('@/app/api/ai/suggest/route')

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify([
        { text: 'Add Docker and Kubernetes to your skills section', target: 'skills', action: 'add_keywords', proposed: 'Docker, Kubernetes, JavaScript' },
        { text: 'Quantify your experience with numbers and metrics', target: 'experience', action: 'enhance', proposed: 'Improved latency by 40%' },
        { text: 'Tailor your summary to mention cloud-native development', target: 'summary', action: 'rewrite', proposed: 'Cloud-native engineer with...' },
      ]) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    const req = fakeNextRequest({
      resumeContent: { summary: 'Dev', skills: ['js'], experience: [] },
      jobTitle: 'Cloud Engineer',
    })
    const res = await POST(req as never)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.suggestions).toHaveLength(3)
    expect(body.suggestions[0].text).toContain('Docker')
    expect(body.suggestions[0].applied).toBe(false)
  })

  it('handles markdown-wrapped JSON responses', async () => {
    const { POST } = await import('@/app/api/ai/suggest/route')

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n[{"text":"Suggestion one","target":"summary","action":"rewrite"},{"text":"Suggestion two","target":"skills","action":"add_keywords"},{"text":"Suggestion three","target":"experience","action":"enhance"}]\n```' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    const req = fakeNextRequest({
      resumeContent: { summary: 'test' },
    })
    const res = await POST(req as never)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.suggestions).toHaveLength(3)
  })
})
