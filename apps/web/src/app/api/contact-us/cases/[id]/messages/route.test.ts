import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), findFirst: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({ requireAuth: mocks.requireAuth, isErrorResponse: (value: unknown) => value instanceof Response, ok: (body: unknown, status = 200) => Response.json(body, { status }), err: (message: string, status = 400) => Response.json({ error: message }, { status }) }))
vi.mock('@/lib/db', () => ({ db: { supportCase: { findFirst: mocks.findFirst } } }))

describe('candidate Contact us messages', () => {
  beforeEach(() => { vi.resetModules(); mocks.requireAuth.mockReset().mockResolvedValue({ userId: 'user-a' }); mocks.findFirst.mockReset() })

  it('filters internal notes and scopes the case lookup to the requester', async () => {
    mocks.findFirst.mockResolvedValue({ messages: [{ id: 'm-1', authorType: 'staff_reply', body: 'Reply', redacted: false, createdAt: new Date('2026-08-06T00:00:00Z') }] })
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/contact-us/cases/case-1/messages'), { params: Promise.resolve({ id: 'case-1' }) })
    expect(response.status).toBe(200)
    expect((await response.json()).messages).toHaveLength(1)
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'case-1', requesterUserId: 'user-a' } }))
  })

  it('does not reveal another candidate case', async () => {
    mocks.findFirst.mockResolvedValue(null)
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/contact-us/cases/foreign/messages'), { params: Promise.resolve({ id: 'foreign' }) })
    expect(response.status).toBe(404)
  })
})
