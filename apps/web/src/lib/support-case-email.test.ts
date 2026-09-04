import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/api-usage/external-api-usage', () => ({ trackedExternalApiFetch: mocks.fetch }))

describe('support case reply email', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.fetch.mockReset().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubEnv('RESEND_API_KEY', 'resend_test_key')
    vi.stubEnv('EMAIL_FROM', 'ApplyMate <no-reply@example.test>')
  })

  afterEach(() => vi.unstubAllEnvs())

  it('sends a reply to a valid external contact', async () => {
    const { sendSupportCaseReplyEmail } = await import('./support-case-email')
    await expect(sendSupportCaseReplyEmail({ recipient: 'ada@example.com', subject: 'Website contact form', body: '<b>Hello</b>' })).resolves.toBe(true)
    const payload = JSON.parse(mocks.fetch.mock.calls[0][1].body) as { to: string[]; reply_to: string; subject: string; html: string }
    expect(payload.to).toEqual(['ada@example.com'])
    expect(payload.reply_to).toBe('hello@applymate.ai')
    expect(payload.subject).toBe('Re: Website contact form')
    expect(payload.html).not.toContain('<b>Hello</b>')
  })

  it('does not call the provider when contact email is not configured', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    const { sendSupportCaseReplyEmail } = await import('./support-case-email')
    await expect(sendSupportCaseReplyEmail({ recipient: 'ada@example.com', subject: 'Question', body: 'Hello' })).resolves.toBe(false)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
