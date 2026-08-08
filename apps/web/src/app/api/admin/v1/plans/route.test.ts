import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePricingReadAdmin: vi.fn(),
  requirePricingWriteAdmin: vi.fn(),
  audit: vi.fn(),
  getAdminPlans: vi.fn(),
  upsert: vi.fn(),
  transaction: vi.fn(),
  validateWrite: vi.fn(),
  runMutation: vi.fn(),
}))

vi.mock('@/lib/admin/pricing-access', () => ({ requirePricingReadAdmin: mocks.requirePricingReadAdmin, requirePricingWriteAdmin: mocks.requirePricingWriteAdmin }))
vi.mock('@/lib/admin/authorization', () => ({ isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validateWrite }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.runMutation }))
vi.mock('@/lib/plan-catalogue', () => ({ getAdminPlans: mocks.getAdminPlans }))
vi.mock('@/lib/db', () => ({ db: { planCatalogue: { upsert: mocks.upsert }, $transaction: mocks.transaction } }))
vi.mock('@/lib/api-helpers', () => ({
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

const plans = [
  { key: 'free', name: 'Free', priceMinor: 0, currency: 'EUR', interval: 'forever', description: 'Free', features: ['Tracker'], badge: null, cta: 'Start', trialDays: 0, active: true, sortOrder: 0 },
  { key: 'pro', name: 'Pro', priceMinor: 1200, currency: 'EUR', interval: 'month', description: 'Pro', features: ['AI'], badge: 'Popular', cta: 'Upgrade', trialDays: 14, active: true, sortOrder: 1 },
  { key: 'enterprise', name: 'Team', priceMinor: 2900, currency: 'EUR', interval: 'month', description: 'Team', features: ['Seats'], badge: null, cta: 'Contact', trialDays: 0, active: true, sortOrder: 2 },
] as const

function request(body?: unknown, idempotencyKey = 'plans-key-1') {
  return new Request('http://localhost/api/admin/v1/plans', {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: body === undefined
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': idempotencyKey },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('admin plans API', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requirePricingReadAdmin.mockReset()
    mocks.requirePricingWriteAdmin.mockReset()
    mocks.audit.mockReset()
    mocks.getAdminPlans.mockReset()
    mocks.upsert.mockReset()
    mocks.transaction.mockReset()
    mocks.validateWrite.mockReset()
    mocks.runMutation.mockReset()
    mocks.requirePricingReadAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'billing', requestId: 'request_1' })
    mocks.requirePricingWriteAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'billing', requestId: 'request_1' })
    mocks.getAdminPlans.mockResolvedValue(plans.map(plan => ({ ...plan, features: [...plan.features] })))
    mocks.transaction.mockResolvedValue([])
    mocks.validateWrite.mockReturnValue(null)
    mocks.runMutation.mockResolvedValue({ duplicate: false, value: [] })
  })

  it('denies non-admin access before reading plans', async () => {
    mocks.requirePricingReadAdmin.mockResolvedValueOnce(Response.json({ error: 'Admin access denied' }, { status: 403 }))
    const { GET } = await import('./route')
    const response = await GET(request() as never)

    expect(response.status).toBe(403)
    expect(mocks.getAdminPlans).not.toHaveBeenCalled()
  })

  it('rejects an inactive Free plan', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(request({ plans: plans.map(plan => ({ ...plan, active: plan.key === 'free' ? false : true })) }) as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Free plan must remain active' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('updates a valid catalogue through one idempotent mutation', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(request({ plans: plans.map(plan => ({ ...plan, priceMinor: plan.key === 'pro' ? 1500 : plan.priceMinor })) }) as never)

    expect(response.status).toBe(200)
    expect(mocks.runMutation).toHaveBeenCalledTimes(1)
    expect(mocks.transaction).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({ plans: expect.any(Array) })
  })

  it('rejects writes that fail the admin origin and idempotency checks', async () => {
    mocks.validateWrite.mockReturnValue(Response.json({ error: 'Invalid request origin' }, { status: 403 }))
    const { PATCH } = await import('./route')
    const response = await PATCH(request({ plans }) as never)

    expect(response.status).toBe(403)
    expect(mocks.runMutation).not.toHaveBeenCalled()
  })

  it('uses an idempotent audit transaction for catalogue updates', async () => {
    const { PATCH } = await import('./route')
    await PATCH(request({ plans }, 'plans-key-2') as never)

    expect(mocks.runMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plans.catalogue_updated',
      idempotencyKey: 'plans-key-2',
    }))
  })

  it('returns a duplicate response without re-reading or reporting a second save', async () => {
    mocks.runMutation.mockResolvedValueOnce({ duplicate: true })
    const { PATCH } = await import('./route')

    const response = await PATCH(request({ plans }, 'plans-key-duplicate') as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ duplicate: true })
  })
})
