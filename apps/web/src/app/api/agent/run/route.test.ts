import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  prepareAiRoute: vi.fn(),
  findFirst: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  sseResponse: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: { agentSession: { findFirst: mocks.findFirst } },
}))

describe('agent run API session binding', () => {
  beforeEach(() => {
    mocks.prepareAiRoute.mockReset()
    mocks.findFirst.mockReset()
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: { provider: 'test', model: 'm1' } })
  })

  it('refuses to start a pipeline for a deleted or foreign requested session', async () => {
    mocks.findFirst.mockResolvedValueOnce(null)
    const { GET } = await import('./route')

    const response = await GET(new NextRequest('http://localhost/api/agent/run?sessionId=deleted_session') as never)
    if (!response) throw new Error('Expected a response')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Session not found' })
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: 'deleted_session', userId: 'user_1' },
      select: { id: true },
    })
  })
})
