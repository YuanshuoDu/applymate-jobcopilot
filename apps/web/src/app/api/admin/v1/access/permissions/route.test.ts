import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn() }))

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))

describe('GET /api/admin/v1/access/permissions', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAdmin.mockReset()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', permissions: ['admin_members.read'] })
  })

  it('returns the allow-listed catalogue with no-store headers', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/access/permissions') as never)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('x-request-id')).toBeTruthy()
    const body = await response.json()
    expect(body.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'admin_members.read' }),
      expect.objectContaining({ key: 'billing.update' }),
    ]))
  })
})
