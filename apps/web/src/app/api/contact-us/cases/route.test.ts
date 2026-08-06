import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), findMany: vi.fn(), userFindUnique: vi.fn(), transaction: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({ requireAuth: mocks.requireAuth, isErrorResponse: (value: unknown) => value instanceof Response, ok: (body: unknown, status = 200) => Response.json(body, { status }), err: (message: string, status = 400) => Response.json({ error: message }, { status }) }))
vi.mock('@/lib/db', () => ({ db: { supportCase: { findMany: mocks.findMany }, user: { findUnique: mocks.userFindUnique }, $transaction: mocks.transaction } }))

describe('candidate Contact us cases', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: 'user-a' })
    mocks.findMany.mockReset().mockResolvedValue([])
    mocks.userFindUnique.mockReset().mockResolvedValue({ id: 'user-a', plan: 'pro', accountStatus: 'active', _count: { jobs: 2, applicationTasks: 1 } })
    mocks.transaction.mockReset()
  })

  it('lists only cases owned by the authenticated candidate', async () => {
    const { GET } = await import('./route')
    await GET()
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { requesterUserId: 'user-a' } }))
  })

  it('redacts secret-like text before creating the case message', async () => {
    const createCase = vi.fn().mockResolvedValue({ id: 'case-1' })
    const createMessage = vi.fn().mockResolvedValue({ id: 'message-1' })
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({ supportCase: { create: createCase }, supportCaseMessage: { create: createMessage } }))
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/contact-us/cases', { method: 'POST', body: JSON.stringify({ subject: 'API issue', category: 'technical', message: 'Use Bearer abcdefghijklmnop1234' }) }))
    expect(response.status).toBe(201)
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ body: expect.stringContaining('[REDACTED]'), redacted: true }) }))
  })
})
