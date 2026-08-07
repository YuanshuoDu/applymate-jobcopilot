import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ admin: vi.fn(), queryRaw: vi.fn() }))
vi.mock('@/lib/admin/settings-access', () => ({ requireSettingsAdmin: mocks.admin }))
vi.mock('@/lib/db', () => ({ db: { $queryRaw: mocks.queryRaw } }))
vi.mock('@/lib/api-helpers', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

describe('GET /api/admin/observability', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.admin.mockReset(); mocks.queryRaw.mockReset()
    mocks.admin.mockResolvedValue({ userId: 'admin_1', email: 'admin@example.com' })
    mocks.queryRaw.mockResolvedValue([])
  })

  it('denies unauthorised callers before querying operational data', async () => {
    mocks.admin.mockResolvedValue(Response.json({ error: 'Admin access denied' }, { status: 403 }))
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/admin/observability') as never)
    expect(response.status).toBe(403)
    expect(mocks.queryRaw).not.toHaveBeenCalled()
  })

  it('marks successful responses as private admin data', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/admin/observability') as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
