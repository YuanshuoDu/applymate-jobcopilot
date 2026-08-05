import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }))

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server')
  return { requireAuth: vi.fn().mockResolvedValue({ userId: 'candidate-a' }), isErrorResponse: (value: unknown) => value instanceof NextResponse }
})
vi.mock('@/lib/db', () => ({ db: { supportCase: { findFirst: mocks.findFirst } } }))

describe('GET /api/contact-us/cases/:id/messages', () => {
  beforeEach(() => { vi.resetModules(); mocks.findFirst.mockReset() })

  it('scopes a guessed case ID to the authenticated candidate and omits internal notes', async () => {
    mocks.findFirst.mockResolvedValue(null)
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/contact-us/cases/case-b/messages') as never, { params: Promise.resolve({ id: 'case-b' }) })
    expect(response.status).toBe(404)
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'case-b', requesterUserId: 'candidate-a' },
      select: expect.objectContaining({ messages: expect.objectContaining({ where: { authorType: { not: 'internal_note' } } }) }),
    }))
  })
})
