import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getPublicPlans: vi.fn() }))

vi.mock('@/lib/plan-catalogue', () => ({ getPublicPlans: mocks.getPublicPlans }))

describe('public plans API', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.getPublicPlans.mockReset()
  })

  it('returns only the public active catalogue', async () => {
    mocks.getPublicPlans.mockResolvedValue([
      { key: 'pro', name: 'Pro', price: '€12', currency: 'EUR', interval: 'month', period: 'month', description: 'For candidates', features: ['AI tailoring'], badge: null, cta: 'Start', trialDays: 14 },
    ])
    const { GET } = await import('./route')
    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ plans: expect.any(Array) })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
