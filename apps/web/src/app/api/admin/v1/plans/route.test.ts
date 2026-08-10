import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), create: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), csrf: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { planCatalog: { findMany: mocks.findMany, create: mocks.create } } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWriteRequest: mocks.csrf }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))

describe('plans catalogue API', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'billing', permissions: ['billing.read', 'billing.update'] })
    mocks.csrf.mockReturnValue({ ok: true })
    mocks.findMany.mockResolvedValue([{ id: 'plan_1', plan: 'pro', name: 'Pro', description: 'Full access', monthlyPriceCents: 1900, yearlyPriceCents: 19000, currency: 'EUR', active: true, version: 1, entitlements: [] }])
    mocks.create.mockResolvedValue({ id: 'plan_2', plan: 'enterprise', name: 'Enterprise', description: null, monthlyPriceCents: 4900, yearlyPriceCents: 49000, currency: 'EUR', active: true, version: 1, entitlements: [] })
    mocks.idempotency.mockImplementation(async (_db: unknown, _input: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({ planCatalog: { create: mocks.create }, adminAuditLog: { create: mocks.audit } }))
  })

  it('lists catalogue metadata without secrets', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/plans') as never)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ items: [{ plan: 'pro', monthlyPriceCents: 1900 }] })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('creates a catalogue plan as an audited idempotent write', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/plans', { method: 'POST', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'plan-create-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: 'enterprise', name: 'Enterprise', monthlyPriceCents: 4900, yearlyPriceCents: 49000, currency: 'EUR', reason: 'Publish enterprise catalogue' }) }) as never)
    expect(response.status).toBe(201)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ plan: 'enterprise', currency: 'EUR' }) }))
    expect(mocks.audit).toHaveBeenCalled()
  })
})
