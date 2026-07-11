import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (val: unknown) => val instanceof Response,
  ok: (data: unknown) => Response.json(data),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock('@/lib/db', () => ({
  db: {
    agentConfig: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
  },
}))

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/agent', {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

describe('agent config API', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.upsert.mockResolvedValue({ userId: 'user_1', minMatchScore: 85, autoApply: true })
  })

  it('updates only validated agent config fields', async () => {
    const { PATCH } = await import('./route')

    const res = await PATCH(patchRequest({
      minMatchScore: 85,
      autoApply: true,
      targetLocations: ['Berlin'],
      unknownField: 'ignored',
    }) as never)

    expect(res.status).toBe(200)
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      update: {
        autoApply: true,
        minMatchScore: 85,
        targetLocations: ['Berlin'],
      },
      create: expect.objectContaining({
        userId: 'user_1',
        autoApply: true,
        minMatchScore: 85,
        targetLocations: ['Berlin'],
      }),
    })
  })

  it('rejects invalid field types before writing config', async () => {
    const { PATCH } = await import('./route')

    const res = await PATCH(patchRequest({
      minMatchScore: '85',
    }) as never)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'minMatchScore must be an integer' })
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
})
