import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { adminMembership: { findMany: mocks.findMany } } }))

describe('GET /api/admin/v1/access/members', () => {
  beforeEach(() => {
    vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.findMany.mockReset()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', permissions: ['admin_members.read'] })
    mocks.findMany.mockResolvedValue([{
      id: 'membership_1', userId: 'user_1', status: 'active', mfaLevel: 'totp', sessionVersion: 2,
      grantedAt: new Date('2026-08-01T00:00:00.000Z'), role: { key: 'support', name: 'Support', permissions: ['users.read'] },
      user: { id: 'user_1', email: 'member@example.com', name: 'Member User', plan: 'pro' },
    }])
  })

  it('returns masked member DTOs and never candidate secrets', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/access/members') as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.json()
    expect(body.items[0]).toMatchObject({ user: { email: 'm***@example.com', name: 'M*** U***' } })
    expect(JSON.stringify(body)).not.toContain('password')
  })
})
