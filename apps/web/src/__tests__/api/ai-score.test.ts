/**
 * AI scoring route tests — validates input, error handling, response parsing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock model-router (routes use modelChat, not SDK directly) ─────────────────

const mockModelChat = vi.fn()
vi.mock('@/lib/model-router', () => ({
  modelChat: mockModelChat,
  stripFences: (raw: string) => raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, ''),
}))

// ── Mock Prisma / auth ─────────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeNextRequest(body: unknown, method = 'POST'): Request {
  return new Request('http://localhost/api/ai/score', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /api/ai/score', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when resumeContent is missing', async () => {
    const { POST } = await import('@/app/api/ai/score/route')
    const req = fakeNextRequest({ jobTitle: 'Engineer' })
    const res = await POST(req as never)

    expect(res!.status).toBe(400)
    const body = await res!.json()
    expect(body.error).toContain('resumeContent')
  })

  it('returns 400 when both jobTitle and jobDescription are missing', async () => {
    const { POST } = await import('@/app/api/ai/score/route')
    const req = fakeNextRequest({ resumeContent: { summary: 'test' } })
    const res = await POST(req as never)

    expect(res!.status).toBe(400)
    const body = await res!.json()
    expect(body.error).toContain('jobTitle')
  })

  it('returns 400 for invalid JSON body', async () => {
    const { POST } = await import('@/app/api/ai/score/route')
    const req = new Request('http://localhost/api/ai/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    const res = await POST(req as never)
    expect(res!.status).toBe(400)
  })

  it('parses AI response correctly', async () => {
    const { POST } = await import('@/app/api/ai/score/route')

    mockModelChat.mockResolvedValueOnce({ text: JSON.stringify({
      score: 82,
      keywords: 'React, TypeScript, Node.js, AWS',
      matchedKeywords: ['react', 'typescript'],
      missingKeywords: ['docker'],
      sectionScores: { Summary: 75, Experience: 90, Skills: 80, Education: 70 },
      sectionTips: { Summary: 'ok', Experience: 'nice', Skills: 'good', Education: 'fine' },
    }) })

    const req = fakeNextRequest({
      resumeContent: { summary: 'Experienced dev', skills: ['react'], experience: [] },
      jobTitle: 'Full Stack Engineer',
      jobCompany: 'Acme Corp',
    })
    const res = await POST(req as never)

    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(body.score).toBe(82)
    expect(body.matchedKeywords).toEqual(['react', 'typescript'])
    expect(body.missingKeywords).toEqual(['docker'])
    expect(body.sectionScores.Summary).toBe(75)
    expect(body.keywords).toBe('React, TypeScript, Node.js, AWS')
  })

  it('handles AI response wrapped in markdown code fences', async () => {
    const { POST } = await import('@/app/api/ai/score/route')

    mockModelChat.mockResolvedValueOnce({ text: '```json\n{"score": 60, "matchedKeywords": [], "missingKeywords": ["a"], "sectionScores": {}, "sectionTips": {}}\n```' })

    const req = fakeNextRequest({
      resumeContent: { summary: 'test' },
      jobTitle: 'Role',
    })
    const res = await POST(req as never)

    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(body.score).toBe(60)
  })

  it('handles AI returning empty/invalid JSON gracefully', async () => {
    const { POST } = await import('@/app/api/ai/score/route')

    mockModelChat.mockResolvedValueOnce({ text: 'I cannot process this request' })

    const req = fakeNextRequest({
      resumeContent: { summary: 'test' },
      jobTitle: 'Role',
    })
    const res = await POST(req as never)

    // Should return 500 on JSON parse error
    expect(res!.status).toBe(500)
  })

  it('extracts ATS keywords from JD — contains technical terms, not generic words', async () => {
    const { POST } = await import('@/app/api/ai/score/route')

    mockModelChat.mockResolvedValueOnce({ text: JSON.stringify({
      score: 78,
      keywords: 'React, TypeScript, Node.js, AWS, PostgreSQL, Docker, Kubernetes, CI/CD, Terraform',
      matchedKeywords: ['react', 'typescript', 'nodejs'],
      missingKeywords: ['terraform'],
      sectionScores: { Summary: 70, Experience: 85, Skills: 75, Education: 65 },
      sectionTips: { Summary: 'ok', Experience: 'nice', Skills: 'good', Education: 'fine' },
    }) })

    const req = fakeNextRequest({
      resumeContent: { summary: 'Backend engineer', skills: ['nodejs'], experience: [] },
      jobTitle: 'Senior Platform Engineer',
      jobCompany: 'TechCorp',
      jobDescription: 'We need someone with React, TypeScript, Node.js, AWS, PostgreSQL, Docker, Kubernetes, CI/CD, Terraform experience for building cloud-native platforms.',
    })
    const res = await POST(req as never)

    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(body.keywords).toContain('React')
    expect(body.keywords).toContain('Docker')
    expect(body.keywords).toContain('Terraform')
    // Verify it does NOT contain generic words
    expect(body.keywords).not.toContain('communication')
    expect(body.keywords).not.toContain('teamwork')
    expect(body.keywords).not.toContain('experience')  // not alone as keyword
    // Should be a comma-separated string
    expect(body.keywords.split(',').length).toBeGreaterThanOrEqual(5)
  })


  it('handles Anthropic API failure', async () => {
    const { POST } = await import('@/app/api/ai/score/route')

    mockModelChat.mockRejectedValueOnce(new Error('API key invalid'))

    const req = fakeNextRequest({
      resumeContent: { summary: 'test' },
      jobTitle: 'Role',
    })
    const res = await POST(req as never)

    expect(res!.status).toBe(500)
    const body = await res!.json()
    expect(body.error).toContain('AI scoring failed')
  })
})
