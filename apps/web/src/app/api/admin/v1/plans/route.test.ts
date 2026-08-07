import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePricingAdmin: vi.fn(),
  getAdminPlans: vi.fn(),
  upsert: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@/lib/admin/pricing-access', () => ({ requirePricingAdmin: mocks.requirePricingAdmin }))
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

function request(body?: unknown) {
  return new Request('http://localhost/api/admin/v1/plans', {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('admin plans API', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requirePricingAdmin.mockReset()
    mocks.getAdminPlans.mockReset()
    mocks.upsert.mockReset()
    mocks.transaction.mockReset()
    mocks.requirePricingAdmin.mockResolvedValue({ userId: 'admin_1', email: 'admin@example.com' })
    mocks.getAdminPlans.mockResolvedValue(plans.map(plan => ({ ...plan, features: [...plan.features] })))
    mocks.transaction.mockResolvedValue([])
  })

  it('denies non-admin access before reading plans', async () => {
    mocks.requirePricingAdmin.mockResolvedValueOnce(Response.json({ error: 'Admin access denied' }, { status: 403 }))
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

  it('updates a valid catalogue in one transaction', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(request({ plans: plans.map(plan => ({ ...plan, priceMinor: plan.key === 'pro' ? 1500 : plan.priceMinor })) }) as never)

    expect(response.status).toBe(200)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    await expect(response.json()).resolves.toEqual({ plans: expect.any(Array) })
  })
})
