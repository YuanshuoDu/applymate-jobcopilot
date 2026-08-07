import { describe, expect, it, vi } from 'vitest'

const requireSettingsAdmin = vi.hoisted(() => vi.fn())

vi.mock('./settings-access', () => ({ requireSettingsAdmin }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: vi.fn(),
  isErrorResponse: (value: unknown) => value instanceof Response,
  err: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: vi.fn() } } }))

import { requirePricingAdmin } from './pricing-access'

describe('pricing admin access', () => {
  it('delegates authorization to the shared admin guard', async () => {
    const actor = { userId: 'admin_1', email: 'admin@example.com' }
    requireSettingsAdmin.mockResolvedValue(actor)

    await expect(requirePricingAdmin(new Request('http://localhost/admin/plans') as never)).resolves.toBe(actor)
    expect(requireSettingsAdmin).toHaveBeenCalledTimes(1)
  })
})
