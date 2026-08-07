import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  legacyAdmin: vi.fn(),
  audit: vi.fn(),
  userCount: vi.fn(),
  userGroupBy: vi.fn(),
  applyCount: vi.fn(),
  queryRaw: vi.fn(),
}))

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/settings-access', () => ({ requireSettingsAdmin: mocks.legacyAdmin }))
vi.mock('@/lib/admin/integration-status', () => ({
  platformIntegrationStatus: () => ({
    ai: { providers: { minimax: true } },
    discovery: { adzuna: false, rapidapi: true },
    oauth: { google: true, github: false },
    messaging: { resend: true },
    infrastructure: { database: true, redis: false },
  }),
}))
vi.mock('@/lib/db', () => ({ db: {
  user: { count: mocks.userCount, groupBy: mocks.userGroupBy },
  applyResult: { count: mocks.applyCount },
  $queryRaw: mocks.queryRaw,
} }))
vi.mock('@/lib/api-helpers', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

describe('GET /api/admin/v1/platform', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'operations', requestId: 'request_1' })
    mocks.legacyAdmin.mockResolvedValue({ userId: 'admin_1', email: 'admin@example.com' })
    mocks.userCount.mockResolvedValue(12)
    mocks.userGroupBy.mockResolvedValue([
      { plan: 'free', _count: { _all: 8 } },
      { plan: 'pro', _count: { _all: 4 } },
    ])
    mocks.applyCount.mockResolvedValue(30)
    mocks.queryRaw.mockResolvedValue([{ status: 'requested', count: 1 }, { status: 'processing', count: 2 }])
  })

  it('requires observability.read and returns operational counts with boolean integration health', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/platform') as never)

    expect(response.status).toBe(200)
    expect(mocks.requireAdmin).toHaveBeenCalledWith('observability.read', expect.any(Request))
    await expect(response.json()).resolves.toMatchObject({
      users: { total: 12, byPlan: { free: 8, pro: 4 } },
      applies: { total: 30 },
      deletionRequests: { requested: 1, processing: 2 },
      integrations: { discovery: { rapidapi: true } },
    })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform.viewed' }))
  })

  it('denies non-admin callers before querying platform data', async () => {
    mocks.requireAdmin.mockResolvedValue(Response.json({ error: 'Admin access denied' }, { status: 403 }))
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/platform') as never)

    expect(response.status).toBe(403)
    expect(mocks.userCount).not.toHaveBeenCalled()
  })
})
