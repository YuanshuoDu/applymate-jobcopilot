import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), getProfile: vi.fn(), context: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/persona', () => ({ getPersonaProfile: mocks.getProfile, personaContext: mocks.context }))

describe('GET /api/me/persona', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset(); mocks.getProfile.mockReset(); mocks.context.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.getProfile.mockResolvedValue({ applicationAnswers: [] })
    mocks.context.mockReturnValue('SAFE PERSONA')
  })

  it('scopes Persona retrieval for form filling', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/me/persona?use=form_fill') as never)

    expect(response.status).toBe(200)
    expect(mocks.getProfile).toHaveBeenCalledWith('user_1', 'form_fill')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('rejects an unsupported retrieval purpose', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/me/persona?use=analytics') as never)

    expect(response.status).toBe(400)
    expect(mocks.getProfile).not.toHaveBeenCalled()
  })
})
