import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { user: { findMany: mocks.findMany } } }))

describe('GET /api/admin/v1/users', () => {
  beforeEach(() => { vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.findMany.mockReset(); mocks.audit.mockReset() })
  it('requires users.read and selects metadata without password fields', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'support', requestId: 'req-1' })
    mocks.findMany.mockResolvedValue([])
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/users?limit=999') as never)
    expect(response.status).toBe(200)
    expect(mocks.requireAdmin).toHaveBeenCalledWith('users.read', expect.any(Request))
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101, select: expect.not.objectContaining({ password: true }) }))
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null })
  })
})
