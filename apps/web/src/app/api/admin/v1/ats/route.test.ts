import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { atsEmployer: { findMany: mocks.findMany } } }))

describe('GET /api/admin/v1/ats', () => {
  beforeEach(() => { vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.findMany.mockReset(); mocks.audit.mockReset() })
  it('returns registry metadata and the coded hard rate limit only', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'req-1' })
    mocks.findMany.mockResolvedValue([{ id: 1, atsType: 'lever', slug: 'spotify', name: 'Spotify', firstSeen: new Date(), lastSeen: new Date(), jobCount: 4 }])
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/ats') as never)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ items: [expect.objectContaining({ rateLimitRps: 5, credentialRequirement: 'none' })] }))
    expect(mocks.requireAdmin).toHaveBeenCalledWith('ats.read', expect.any(Request))
  })

  it('applies employer search and enabled/source filters', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'req-1' })
    mocks.findMany.mockResolvedValue([])
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/ats?q=trade&atsType=lever&enabled=false&sort=name&direction=desc') as never)

    expect(response.status).toBe(200)
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { atsType: 'lever', enabled: false, OR: expect.arrayContaining([{ name: { contains: 'trade', mode: 'insensitive' } }]) },
      orderBy: [{ name: 'desc' }, { id: 'asc' }],
    }))
  })

  it('does not advertise unmanaged ATS registries as Worker controls', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'req-1' })
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/ats?atsType=personio') as never)

    expect(response.status).toBe(400)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})
