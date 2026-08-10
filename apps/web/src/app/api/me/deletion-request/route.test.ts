import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: {
  user: { findUnique: mocks.findUnique },
  activity: { create: mocks.activityCreate },
  $transaction: mocks.transaction,
} }))

describe('POST /api/me/deletion-request', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.findUnique.mockResolvedValue({ preferences: {
      targetRoles: 'Engineer',
      aiSettings: { keys: { openai: 'secret-ref' } },
    } })
    mocks.update.mockResolvedValue({ preferences: {} })
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      user: { update: mocks.update },
      activity: { create: mocks.activityCreate },
    }))
  })

  it('records a deletion request without replacing existing preferences', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/deletion-request', { method: 'POST' }) as never)

    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user_1' },
      data: expect.objectContaining({
        preferences: expect.objectContaining({
          targetRoles: 'Engineer',
          aiSettings: { keys: { openai: 'secret-ref' } },
          dataDeletionRequestStatus: 'requested',
          dataDeletionRequestedAt: expect.any(String),
        }),
      }),
    }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user_1', type: 'note_added' }),
    }))
  })

  it('is idempotent when a request already exists', async () => {
    mocks.findUnique.mockResolvedValue({ preferences: {
      dataDeletionRequestStatus: 'requested',
      dataDeletionRequestedAt: '2026-08-05T10:00:00.000Z',
    } })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/deletion-request', { method: 'POST' }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      requested: true,
      requestedAt: '2026-08-05T10:00:00.000Z',
      status: 'requested',
    })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })
})
