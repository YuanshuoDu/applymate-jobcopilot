import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), createCase: vi.fn(), notifySupportAdmins: vi.fn(), rateLimit: vi.fn() }))
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
vi.mock('@/lib/db', () => ({ db: { supportCase: { create: mocks.createCase } } }))
vi.mock('@/lib/admin/admin-notifications', () => ({ notifySupportAdmins: mocks.notifySupportAdmins }))
vi.mock('@/lib/distributed-rate-limit', () => ({ checkDistributedRateLimit: mocks.rateLimit }))
vi.mock('@/lib/request-client-ip', () => ({ getClientIp: () => '203.0.113.8' }))

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
    vi.clearAllMocks()
    mocks.fetch.mockReset()
    mocks.createCase.mockReset()
    mocks.notifySupportAdmins.mockReset()
    mocks.rateLimit.mockReset()
    vi.stubEnv('RESEND_API_KEY', 'resend_test_key')
    vi.stubEnv('EMAIL_FROM', 'ApplyMate <no-reply@example.test>')
    vi.stubEnv('CONTACT_TO_EMAIL', 'hello@example.test')
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }))
    mocks.createCase.mockResolvedValue({ id: 'case-1', subject: 'Landing page contact', messages: [{ id: 'message-1' }] })
    mocks.notifySupportAdmins.mockResolvedValue(undefined)
    mocks.rateLimit.mockResolvedValue({ ok: true })
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
    expect(mocks.createCase).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('still creates a support case when the email provider is unavailable', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    const { POST } = await import('./route')
    const response = await POST(request({ name: 'Ada', email: 'ada@example.com', message: 'Hello' }) as never)

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ ok: true, caseId: 'case-1', emailSent: false })
    expect(mocks.createCase).toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('creates a support case and preserves the internal email notification', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ name: 'Ada', email: 'ada@example.com', message: '<script>alert(1)</script>' }) as never)

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ ok: true, caseId: 'case-1', emailSent: true })
    const createInput = mocks.createCase.mock.calls[0][0] as { data: { requesterName: string; requesterEmail: string; subject: string; category: string; messages: { create: { body: string; redacted: boolean } } } }
    expect(createInput.data).toEqual(expect.objectContaining({ requesterName: 'Ada', requesterEmail: 'ada@example.com', subject: 'Landing page contact', category: 'other' }))
    expect(createInput.data.messages.create.redacted).toBe(false)
    expect(mocks.notifySupportAdmins).toHaveBeenCalledWith({ caseId: 'case-1', messageId: 'message-1', subject: 'Landing page contact', event: 'new_case' })
    const payload = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body)) as { to: string[]; text: string; html: string }
    expect(payload.to).toEqual(['hello@example.test'])
    expect(payload.text).toContain("<script>alert(1)</script>")
    expect(payload.html).not.toContain('<script>')
  })

  it('does not lose the ticket when the internal email provider fails', async () => {
    mocks.fetch.mockResolvedValue(new Response('provider down', { status: 503 }))
    const { POST } = await import('./route')
    const response = await POST(request({ name: 'Ada', email: 'ada@example.com', message: 'Hello' }) as never)

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ ok: true, caseId: 'case-1', emailSent: false })
    expect(mocks.createCase).toHaveBeenCalled()
  })

  it('rate limits public contact submissions before creating a case', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ ok: false, retryAfter: 45 })
    const { POST } = await import('./route')
    const response = await POST(request({ name: 'Ada', email: 'ada@example.com', message: 'Hello' }) as never)

    expect(response.status).toBe(429)
    expect(mocks.createCase).not.toHaveBeenCalled()
  })

  it('fails closed when the distributed rate-limit store is unavailable', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ ok: false, retryAfter: 60, unavailable: true })
    const { POST } = await import('./route')
    const response = await POST(request({ name: 'Ada', email: 'ada@example.com', message: 'Hello' }) as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'Contact service is temporarily unavailable. Please try again later.' })
    expect(mocks.createCase).not.toHaveBeenCalled()
  })
})
