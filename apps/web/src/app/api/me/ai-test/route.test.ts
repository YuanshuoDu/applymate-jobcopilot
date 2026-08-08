import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findUnique: vi.fn(),
  modelChat: vi.fn(),
  resolveConfig: vi.fn(),
  resolveFeatureConfig: vi.fn(),
  checkDistributedRateLimit: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/distributed-rate-limit', () => ({ checkDistributedRateLimit: mocks.checkDistributedRateLimit }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique } } }))
vi.mock('@/lib/model-router', () => ({
  MODEL_CATALOGUE: [
    { provider: 'openai', model: 'gpt-5.5', defaultBase: 'https://api.openai.com/v1' },
    { provider: 'custom', model: 'custom' },
  ],
  modelChat: mocks.modelChat,
  resolveConfig: mocks.resolveConfig,
  resolveFeatureConfig: mocks.resolveFeatureConfig,
}))

describe('POST /api/me/ai-test', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.findUnique.mockResolvedValue({ preferences: { aiSettings: { keys: {}, features: {} } } })
    mocks.resolveConfig.mockImplementation((config: Record<string, unknown>) => ({
      ...config,
      apiBase: config.apiBase ?? 'https://api.openai.com/v1',
      resolvedKey: config.apiKey ?? '',
    }))
    mocks.resolveFeatureConfig.mockReturnValue({
      provider: 'openai', model: 'gpt-5.5', apiBase: 'https://api.openai.com/v1', resolvedKey: 'saved-key',
    })
    mocks.modelChat.mockResolvedValue({ text: 'ok', provider: 'openai', model: 'gpt-5.5' })
    mocks.checkDistributedRateLimit.mockResolvedValue({ ok: true })
  })

  it('uses the saved feature-specific key when testing a feature', async () => {
    mocks.resolveFeatureConfig.mockReturnValue({
      provider: 'custom', model: 'llama-3.3', apiBase: 'https://llm.example.test/v1', resolvedKey: 'feature-secret',
    })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/me/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: 'agent' }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.resolveFeatureConfig).toHaveBeenCalledWith('agent', expect.any(Object))
    expect(mocks.modelChat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ provider: 'custom', model: 'llama-3.3', apiBase: 'https://llm.example.test/v1', resolvedKey: 'feature-secret' }),
      300,
    )
  })

  it('gives reasoning providers enough output budget to produce a final answer', async () => {
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/me/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-5.5', apiKey: 'secret' }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.modelChat).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), 300)
  })

  it('rate limits platform-backed probes before calling a provider', async () => {
    mocks.checkDistributedRateLimit.mockResolvedValue({ ok: false, retryAfter: 42 })
    mocks.resolveConfig.mockReturnValueOnce({
      provider: 'openai', model: 'gpt-5.5', apiBase: 'https://api.openai.com/v1', resolvedKey: 'platform-key',
    })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/me/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-5.5' }),
    }) as never)

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: 'rate_limited' })
    expect(mocks.checkDistributedRateLimit).toHaveBeenCalledWith('ai-test:user_1:openai', 3, 60_000)
    expect(mocks.modelChat).not.toHaveBeenCalled()
  })

  it('keeps test limits separate for each configured provider', async () => {
    const { POST } = await import('./route')

    const openAiResponse = await POST(new Request('http://localhost/api/me/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-5.5', apiKey: 'openai-secret' }),
    }) as never)
    const customResponse = await POST(new Request('http://localhost/api/me/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', model: 'custom', apiBase: 'https://llm.example.test/v1', apiKey: 'custom-secret' }),
    }) as never)

    expect(openAiResponse.status).toBe(200)
    expect(customResponse.status).toBe(200)
    expect(mocks.checkDistributedRateLimit).toHaveBeenNthCalledWith(1, 'ai-test:user_1:openai', 3, 60_000)
    expect(mocks.checkDistributedRateLimit).toHaveBeenNthCalledWith(2, 'ai-test:user_1:custom', 3, 60_000)
  })

  it('fails closed when the shared rate limiter is unavailable', async () => {
    mocks.checkDistributedRateLimit.mockResolvedValue({ ok: false, retryAfter: 60, unavailable: true })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/me/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-5.5', apiKey: 'secret' }),
    }) as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: 'rate_limit_unavailable' })
    expect(mocks.modelChat).not.toHaveBeenCalled()
  })

  it('rejects an unknown provider or model before making a provider call', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'not-a-real-model', apiKey: 'secret' }),
    }) as never)

    expect(response.status).toBe(400)
    expect(mocks.modelChat).not.toHaveBeenCalled()
  })

  it('returns an actionable status when the effective config has no key', async () => {
    mocks.resolveConfig.mockReturnValue({ provider: 'openai', model: 'gpt-5.5', apiBase: 'https://api.openai.com/v1', resolvedKey: '' })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-5.5' }),
    }) as never)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: 'missing_key' })
    expect(mocks.modelChat).not.toHaveBeenCalled()
  })

  it('rejects custom endpoints that are not HTTPS', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', model: 'llama', apiBase: 'http://localhost:1234/v1', apiKey: 'secret' }),
    }) as never)

    expect(response.status).toBe(400)
    expect(mocks.modelChat).not.toHaveBeenCalled()
  })
})
