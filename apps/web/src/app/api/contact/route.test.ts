import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)))

vi.stubGlobal('fetch', mocks.fetch)
vi.mock('@jobcopilot/shared', async () => {
  const actual = await vi.importActual<typeof import('@jobcopilot/shared')>('@jobcopilot/shared')
  return { ...actual, pinnedFetch }
})
vi.mock('@/lib/api-helpers', () => ({
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

function request(body: unknown, raw = false) {
  return new Request('http://localhost:3000/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? String(body) : JSON.stringify(body),
  })
}

describe('contact API', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.fetch.mockReset()
    vi.stubEnv('RESEND_API_KEY', 'resend_test_key')
    vi.stubEnv('EMAIL_FROM', 'ApplyMate <no-reply@example.test>')
    vi.stubEnv('CONTACT_TO_EMAIL', 'hello@example.test')
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rejects malformed JSON and invalid fields', async () => {
    const { POST } = await import('./route')
    const invalidJson = await POST(request('{', true) as never)
    expect(invalidJson.status).toBe(400)

    const invalidFields = await POST(request({ name: 'A', email: 'not-email', message: '' }) as never)
    expect(invalidFields.status).toBe(400)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('returns a truthful configuration error when Resend is unavailable', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    const { POST } = await import('./route')
    const response = await POST(request({ name: 'Ada', email: 'ada@example.com', message: 'Hello' }) as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'Contact service is not configured. Please email hello@applymate.ai.' })
  })

  it('sends a contact message through Resend', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ name: 'Ada', email: 'ada@example.com', message: '<script>alert(1)</script>' }) as never)

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ ok: true })
    const payload = JSON.parse(mocks.fetch.mock.calls[0][1].body) as { to: string[]; text: string; html: string }
    expect(payload.to).toEqual(['hello@example.test'])
    expect(payload.text).toContain("<script>alert(1)</script>")
    expect(payload.html).not.toContain('<script>')
  })

  it('hides provider failures behind a retryable response', async () => {
    mocks.fetch.mockResolvedValue(new Response('provider down', { status: 503 }))
    const { POST } = await import('./route')
    const response = await POST(request({ name: 'Ada', email: 'ada@example.com', message: 'Hello' }) as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'We could not send your message. Please try again or email hello@applymate.ai.' })
  })
})
