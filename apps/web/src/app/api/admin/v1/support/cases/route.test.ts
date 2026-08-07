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
})
