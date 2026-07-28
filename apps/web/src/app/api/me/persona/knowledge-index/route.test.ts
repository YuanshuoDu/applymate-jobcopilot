import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), sync: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/persona-evidence', () => ({ syncPersonaEvidence: mocks.sync }))

describe('POST /api/me/persona/knowledge-index', () => {
  beforeEach(() => { mocks.requireAuth.mockReset(); mocks.sync.mockReset(); mocks.requireAuth.mockResolvedValue({ userId: 'user_1' }); mocks.sync.mockResolvedValue({ candidates: 3, indexed: 3 }) })

  it('builds only the authenticated user knowledge index without caching the response', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/persona/knowledge-index', { method: 'POST' }) as never)

    expect(mocks.sync).toHaveBeenCalledWith('user_1')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ candidates: 3, indexed: 3 })
  })
})
