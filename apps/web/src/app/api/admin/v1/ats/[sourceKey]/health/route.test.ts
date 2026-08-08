import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findPolicy: vi.fn(), aggregate: vi.fn(), audit: vi.fn() }))

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { atsSourcePolicy: { findUnique: mocks.findPolicy }, atsEmployer: { aggregate: mocks.aggregate } } }))

describe('GET /api/admin/v1/ats/:sourceKey/health', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'req-1' })
    mocks.findPolicy.mockResolvedValue(null)
    mocks.aggregate.mockResolvedValue({ _count: { id: 2 }, _max: { lastSeen: null } })
    mocks.audit.mockResolvedValue(undefined)
  })

  it('states that direct ATS APIs do not require a credential', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/ats/lever/health') as never, { params: Promise.resolve({ sourceKey: 'lever' }) })

    await expect(response.json()).resolves.toEqual(expect.objectContaining({ sourceKey: 'lever', credentialRequirement: 'none' }))
  })

  it('reports the Worker effective default as not configured', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/ats/lever/health') as never, { params: Promise.resolve({ sourceKey: 'lever' }) })

    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      propagation: 'not-configured',
      policy: expect.objectContaining({
        configured: false,
        globalRpsLimit: 4,
        perTenantRpsLimit: 4,
        maxRetries: 0,
        backoffBaseMs: 1000,
        allowAutoApply: true,
      }),
    }))
  })
})
