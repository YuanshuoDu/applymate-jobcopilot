import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkDistributedRateLimit = vi.hoisted(() => vi.fn())

vi.mock('./distributed-rate-limit', () => ({ checkDistributedRateLimit }))

describe('authentication rate-limit keys', () => {
  beforeEach(() => {
    checkDistributedRateLimit.mockReset()
    checkDistributedRateLimit.mockResolvedValue({ ok: true })
  })

  it('uses proxy client identity and a hashed account identifier', async () => {
    const { checkAuthRateLimit } = await import('./auth-rate-limit')
    await checkAuthRateLimit(new Request('https://app.example/api/auth/login', {
      headers: { 'cf-connecting-ip': '203.0.113.8', 'x-forwarded-for': '198.51.100.4' },
    }), 'login', 'Candidate@Example.COM', { ipLimit: 20, identityLimit: 3, windowMs: 60_000 })

    expect(checkDistributedRateLimit).toHaveBeenCalledTimes(2)
    const firstKey = String(checkDistributedRateLimit.mock.calls[0][0])
    const secondKey = String(checkDistributedRateLimit.mock.calls[1][0])
    expect(firstKey).toMatch(/^auth:login:ip:[a-f0-9]{32}$/)
    expect(secondKey).toMatch(/^auth:login:identity:[a-f0-9]{32}$/)
    expect(firstKey).not.toContain('203.0.113.8')
    expect(secondKey).not.toContain('candidate@example.com')
  })

  it('does not spend the identity bucket when the client bucket is blocked', async () => {
    checkDistributedRateLimit.mockResolvedValueOnce({ ok: false, retryAfter: 42 })
    const { checkAuthRateLimit } = await import('./auth-rate-limit')
    const result = await checkAuthRateLimit(new Request('https://app.example/api/auth/login'), 'login', 'candidate@example.com', { ipLimit: 1, identityLimit: 1, windowMs: 60_000 })

    expect(result).toEqual({ ok: false, retryAfter: 42 })
    expect(checkDistributedRateLimit).toHaveBeenCalledTimes(1)
  })
})
