import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }))

vi.mock('@/lib/db', () => ({ db: { atsSourcePolicy: { findUnique: mocks.findUnique } } }))

import { getRuntimeAtsPolicy } from './runtime-ats-policy'

describe('runtime ATS policy', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the shared default limit for an unconfigured source', async () => {
    mocks.findUnique.mockResolvedValue(null)

    await expect(getRuntimeAtsPolicy('greenhouse', 'user-1')).resolves.toEqual({ allowed: true, rps: 4 })
  })

  it('blocks a paused policy before an ATS request can be made', async () => {
    mocks.findUnique.mockResolvedValue({
      state: 'paused', enabled: false, rolloutPercent: 100,
      globalRpsLimit: 5, perTenantRpsLimit: 1, allowAutoApply: true,
    })

    await expect(getRuntimeAtsPolicy('greenhouse', 'user-1')).resolves.toEqual({ allowed: false, rps: 1 })
  })

  it('fails closed when the policy store is available but cannot be read', async () => {
    mocks.findUnique.mockRejectedValue(new Error('database unavailable'))

    await expect(getRuntimeAtsPolicy('greenhouse', 'user-1')).resolves.toEqual({ allowed: false, rps: 5 })
  })
})
