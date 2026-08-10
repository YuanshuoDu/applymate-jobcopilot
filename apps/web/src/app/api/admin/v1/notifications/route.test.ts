import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdminAny: vi.fn(), validateWrite: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdminAny: mocks.requireAdminAny, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validateWrite }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { adminNotification: { findMany: mocks.findMany, count: mocks.count, updateMany: mocks.updateMany } } }))

describe('/api/admin/v1/notifications', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdminAny.mockResolvedValue({ userId: 'admin-1', roleKey: 'support', requestId: 'request-1' })
    mocks.validateWrite.mockReturnValue(null)
    mocks.findMany.mockResolvedValue([])
    mocks.count.mockResolvedValue(0)
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.audit.mockResolvedValue(undefined)
  })

  it('returns the administrator inbox and unread count', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'notification-1', title: 'Customer replied' }])
    mocks.count.mockResolvedValue(1)
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/admin/notifications') as never)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ unreadCount: 1, notifications: [{ id: 'notification-1' }] })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { adminUserId: 'admin-1' } }))
  })

  it('marks only notifications belonging to the current administrator as read', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin/notifications', { method: 'PATCH', headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', 'Idempotency-Key': 'read-1' }, body: JSON.stringify({ id: 'notification-1' }) }) as never)
    expect(response.status).toBe(200)
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: 'notification-1', adminUserId: 'admin-1' }, data: { readAt: expect.any(Date) } })
  })

  it('denies callers without support inbox permission before reading notifications', async () => {
    mocks.requireAdminAny.mockResolvedValue(Response.json({ error: 'Forbidden' }, { status: 403 }))
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/admin/notifications') as never)
    expect(response.status).toBe(403)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})
