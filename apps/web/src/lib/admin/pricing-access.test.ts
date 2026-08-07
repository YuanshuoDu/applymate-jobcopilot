import { describe, expect, it, vi } from 'vitest'

const requireAdmin = vi.hoisted(() => vi.fn())

vi.mock('./authorization', () => ({ requireAdmin }))
vi.mock('./settings-access', () => ({ requireSettingsAdmin: vi.fn() }))

import { requirePricingReadAdmin, requirePricingWriteAdmin } from './pricing-access'

describe('pricing admin access', () => {
  it('uses billing.read for catalogue reads', async () => {
    const actor = { userId: 'admin_1', roleKey: 'billing', requestId: 'request_1' }
    requireAdmin.mockResolvedValue(actor)

    await expect(requirePricingReadAdmin(new Request('http://localhost/admin/plans') as never)).resolves.toBe(actor)
    expect(requireAdmin).toHaveBeenCalledWith('billing.read', expect.any(Request))
  })

  it('uses billing.update for catalogue writes', async () => {
    const actor = { userId: 'admin_1', roleKey: 'billing', requestId: 'request_1' }
    requireAdmin.mockResolvedValue(actor)

    await expect(requirePricingWriteAdmin(new Request('http://localhost/admin/plans') as never)).resolves.toBe(actor)
    expect(requireAdmin).toHaveBeenCalledWith('billing.update', expect.any(Request))
  })
})
