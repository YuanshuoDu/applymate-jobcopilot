import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate } } }))

function request(body: unknown) {
  return new Request('http://localhost:3000/api/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/me', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.userFindUnique.mockResolvedValue({ preferences: {
      aiSettings: { keys: { openai: 'secret-ref' }, features: { scoring: null } },
      futureFlag: { enabled: true },
    } })
    mocks.userUpdate.mockResolvedValue({ id: 'user_1', preferences: {} })
  })

  it('merges profile preferences without deleting AI or future keys', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(request({ preferences: { targetRoles: 'Backend Engineer' } }) as never)

    expect(response.status).toBe(200)
    expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user_1' },
      data: expect.objectContaining({
        preferences: {
          aiSettings: { keys: { openai: 'secret-ref' }, features: { scoring: null } },
          futureFlag: { enabled: true },
          targetRoles: 'Backend Engineer',
        },
      }),
    }))
  })

  it('rejects an unsafe avatar before writing the user row', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(request({ image: 'javascript:alert(1)' }) as never)

    expect(response.status).toBe(400)
    expect(mocks.userUpdate).not.toHaveBeenCalled()
  })

  it('rejects malformed profile field types before writing the user row', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(request({ name: 42 }) as never)

    expect(response.status).toBe(400)
    expect(mocks.userUpdate).not.toHaveBeenCalled()
  })

  it('rejects non-boolean notification patches instead of silently ignoring them', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(request({ preferences: { notificationPreferences: { apply: 'yes' } } }) as never)

    expect(response.status).toBe(400)
    expect(mocks.userUpdate).not.toHaveBeenCalled()
  })

  it('rejects AI settings patches through the profile endpoint', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(request({ preferences: { aiSettings: { keys: { openai: 'attacker-key' } } } }) as never)

    expect(response.status).toBe(400)
    expect(mocks.userUpdate).not.toHaveBeenCalled()
  })

  it('does not expose raw AI credentials in profile responses', async () => {
    mocks.userFindUnique.mockResolvedValueOnce({
      id: 'user_1', email: 'candidate@example.com', name: 'Candidate', image: null, plan: 'free',
      phone: null, location: null, linkedin: null, github: null,
      preferences: {
        targetRoles: 'Engineer',
        aiSettings: {
          keys: { openai: 'provider-secret' },
          features: { scoring: { provider: 'openai', model: 'gpt-5.5', apiKey: 'feature-secret' } },
        },
      },
      createdAt: new Date(), onboardedAt: null, onboardingGoals: [],
    })

    const { GET } = await import('./route')
    const response = await GET()
    const payload = await response.json()

    expect(JSON.stringify(payload)).not.toContain('provider-secret')
    expect(JSON.stringify(payload)).not.toContain('feature-secret')
  })
})
