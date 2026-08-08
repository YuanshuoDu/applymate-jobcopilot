import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique, update: mocks.update } } }))

describe('/api/me/ai-config', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    process.env.MINIMAX_API_KEY = ''
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.findUnique.mockResolvedValue({ preferences: {
      futureFlag: { enabled: true },
      aiSettings: {
        keys: { openai: 'provider-secret' },
        features: {
          scoring: { provider: 'openai', model: 'gpt-5.5', apiKey: 'feature-secret' },
        },
      },
    } })
    mocks.update.mockResolvedValue({})
  })

  it('preserves feature-specific API keys when the UI changes only provider/model', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keys: { openai: '••••cret' },
        features: { scoring: { provider: 'openai', model: 'gpt-5.5' } },
      }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        preferences: expect.objectContaining({
          futureFlag: { enabled: true },
          aiSettings: expect.objectContaining({
            keys: { openai: 'provider-secret' },
            features: expect.objectContaining({
              scoring: { provider: 'openai', model: 'gpt-5.5', apiKey: 'feature-secret' },
            }),
          }),
        }),
      }),
    }))
  })

  it('masks feature keys in GET responses', async () => {
    const { GET } = await import('./route')
    const response = await GET()
    await expect(response.json()).resolves.toMatchObject({
      keys: { openai: '••••cret' },
      features: { scoring: { apiKey: '••••cret' } },
      platform: { minimax: false },
    })
  })

  it('reports platform default readiness without exposing the platform secret', async () => {
    process.env.MINIMAX_API_KEY = 'platform-secret'
    const { GET } = await import('./route')
    const response = await GET()
    const body = await response.json()
    expect(body).toMatchObject({ platform: { minimax: true } })
    expect(JSON.stringify(body)).not.toContain('platform-secret')
  })

  it('rejects malformed provider keys instead of calling string methods on them', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { openai: { secret: true } } }),
    }) as never)

    expect(response.status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('preserves validated endpoint settings and accepts the legacy AgentPage payload', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'custom', model: 'llama-3.3', apiKey: 'custom-secret',
        apiBase: 'https://llm.example.test/v1', thinking: 'disabled',
      }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        preferences: expect.objectContaining({
          aiSettings: expect.objectContaining({
            features: expect.objectContaining({
              agent: {
                provider: 'custom', model: 'llama-3.3', apiKey: 'custom-secret',
                apiBase: 'https://llm.example.test/v1', thinking: 'disabled',
              },
              autoApply: {
                provider: 'custom', model: 'llama-3.3', apiKey: 'custom-secret',
                apiBase: 'https://llm.example.test/v1', thinking: 'disabled',
              },
            }),
          }),
        }),
      }),
    }))
  })

  it('rejects custom models without an HTTPS endpoint', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ features: { agent: { provider: 'custom', model: 'llama-3.3' } } }),
    }) as never)

    expect(response.status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('rejects custom endpoints for platform-backed providers', async () => {
    process.env.MINIMAX_API_KEY = 'platform-secret'
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        features: {
          scoring: {
            provider: 'minimax',
            model: 'MiniMax-M3',
            apiBase: 'https://attacker.example/v1',
          },
        },
      }),
    }) as never)

    expect(response.status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('requires a user key for a custom endpoint even when a server key is configured', async () => {
    process.env.CUSTOM_API_KEY = 'platform-custom-secret'
    mocks.findUnique.mockResolvedValue({ preferences: { aiSettings: { keys: {}, features: {} } } })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        features: {
          agent: {
            provider: 'custom',
            model: 'llama-3.3',
            apiBase: 'https://llm.example.test/v1',
          },
        },
      }),
    }) as never)

    expect(response.status).toBe(422)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('rejects a selected provider when neither the user nor platform has a key', async () => {
    delete process.env.OPENAI_API_KEY
    mocks.findUnique.mockResolvedValue({ preferences: { aiSettings: { keys: {}, features: {} } } })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ features: { scoring: { provider: 'openai', model: 'gpt-5.5' } } }),
    }) as never)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('API key') })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('accepts a selected provider when its key is saved in the same request', async () => {
    delete process.env.OPENAI_API_KEY
    mocks.findUnique.mockResolvedValue({ preferences: { aiSettings: { keys: {}, features: {} } } })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keys: { openai: 'new-secret' },
        features: { scoring: { provider: 'openai', model: 'gpt-5.5' } },
      }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalled()
  })

  it('clears a provider key when the client sends null', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { openai: null } }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        preferences: expect.objectContaining({
          aiSettings: expect.objectContaining({ keys: {} }),
        }),
      }),
    }))
  })

  it('trims provider keys and allows an explicit feature-key clear', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keys: { openai: '  new-secret  ' },
        features: { scoring: { provider: 'openai', model: 'gpt-5.5', apiKey: '' } },
      }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        preferences: expect.objectContaining({
          aiSettings: expect.objectContaining({
            keys: { openai: 'new-secret' },
            features: expect.objectContaining({ scoring: { provider: 'openai', model: 'gpt-5.5' } }),
          }),
        }),
      }),
    }))
  })
})
