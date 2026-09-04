import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), audit: vi.fn() }))

vi.mock('@/lib/admin/authorization', () => ({
  requireAdmin: mocks.requireAdmin,
  isAdminResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { supportCase: { findMany: mocks.findMany } } }))

describe('GET /api/admin/v1/support/cases', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'support', requestId: 'request-1' })
    mocks.findMany.mockResolvedValue([])
  })

  it('rejects an unknown status before querying support cases', async () => {
    const { GET } = await import('./route')
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/support/cases?status=unknown'))

    expect(response.status).toBe(400)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  it('returns a safe external requester shape for landing-page cases', async () => {
    mocks.findMany.mockResolvedValueOnce([{ id: 'case-guest', subject: 'Landing page contact', category: 'other', status: 'open', priority: 'normal', assignedAdminId: null, slaDueAt: null, version: 1, createdAt: new Date('2026-09-04T12:00:00.000Z'), updatedAt: new Date('2026-09-04T12:00:00.000Z'), safeContext: { source: 'landing_contact' }, requesterName: 'Ada Lovelace', requesterEmail: 'ada@example.com', requester: null, messages: [] }])
    const { GET } = await import('./route')
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/support/cases'))
    const payload = await response.json() as { cases: Array<{ requester: { id: string; name: string; email: string; plan: string } }> }

    expect(response.status).toBe(200)
    expect(payload.cases[0].requester).toEqual(expect.objectContaining({ id: 'external:case-guest', name: 'A*** L***', email: 'a***@example.com', plan: 'external' }))
    expect(payload.cases[0]).not.toHaveProperty('requesterEmail')
    expect(payload.cases[0]).not.toHaveProperty('requesterName')
  })
})
