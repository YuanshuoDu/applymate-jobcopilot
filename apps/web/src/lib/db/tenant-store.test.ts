import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ executeRaw: vi.fn(), executeRawUnsafe: vi.fn() }))

describe('tenant store', () => {
  beforeEach(() => {
    mocks.executeRaw.mockReset()
    mocks.executeRawUnsafe.mockReset()
    vi.unstubAllEnvs()
  })

  it('activates a tenant for the current async request context', async () => {
    const { activateTenantContext, currentTenantUserId } = await import('./tenant-store')
    expect(currentTenantUserId()).toBeNull()
    activateTenantContext('user_123')
    expect(currentTenantUserId()).toBe('user_123')
  })

  it('sets the tenant and candidate role inside an RLS transaction', async () => {
    vi.stubEnv('RLS_RUNTIME_MODE', 'on')
    vi.stubEnv('RLS_CANDIDATE_ROLE', 'applymate_candidate')
    const { configureTenantTransaction } = await import('./tenant-store')
    const tx = { $executeRaw: mocks.executeRaw, $executeRawUnsafe: mocks.executeRawUnsafe }
    await configureTenantTransaction(tx as never, 'user_123')
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1)
    expect(mocks.executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE "applymate_candidate"')
  })
})
