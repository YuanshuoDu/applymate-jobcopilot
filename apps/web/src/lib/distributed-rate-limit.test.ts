import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  pttl: vi.fn(),
  on: vi.fn(),
  redis: vi.fn(),
}))

vi.mock('ioredis', () => ({
  Redis: mocks.redis.mockImplementation(() => ({
    eval: mocks.eval,
    pttl: mocks.pttl,
    on: mocks.on,
  })),
}))

describe('checkDistributedRateLimit', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('REDIS_URL', 'redis://rate-limit.test:6379')
    vi.stubEnv('NODE_ENV', 'production')
    mocks.eval.mockResolvedValue(1)
    mocks.pttl.mockResolvedValue(60_000)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('increments and sets the first-window expiry in one atomic Redis operation', async () => {
    const { checkDistributedRateLimit } = await import('./distributed-rate-limit')

    await expect(checkDistributedRateLimit('ai-test:user_1', 3, 60_000)).resolves.toEqual({ ok: true })

    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR', KEYS[1])"),
      1,
      'rate-limit:ai-test:user_1',
      60_000,
    )
    expect(mocks.eval.mock.calls[0]?.[0]).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[1])")
  })

  it('returns the Redis TTL when the shared limit is exhausted', async () => {
    mocks.eval.mockResolvedValue(4)
    mocks.pttl.mockResolvedValue(42_001)
    const { checkDistributedRateLimit } = await import('./distributed-rate-limit')

    await expect(checkDistributedRateLimit('ai-test:user_1', 3, 60_000)).resolves.toEqual({ ok: false, retryAfter: 43 })
  })

  it('fails closed in production when Redis is not configured', async () => {
    vi.stubEnv('REDIS_URL', '')
    const { checkDistributedRateLimit } = await import('./distributed-rate-limit')

    await expect(checkDistributedRateLimit('ai-test:user_1', 3, 60_000)).resolves.toEqual({ ok: false, retryAfter: 60, unavailable: true })
    expect(mocks.redis).not.toHaveBeenCalled()
  })

  it('fails closed when Redis rejects the counter operation', async () => {
    mocks.eval.mockRejectedValue(new Error('Redis unavailable'))
    const { checkDistributedRateLimit } = await import('./distributed-rate-limit')

    await expect(checkDistributedRateLimit('ai-test:user_1', 3, 60_000)).resolves.toEqual({ ok: false, retryAfter: 60, unavailable: true })
  })
})
